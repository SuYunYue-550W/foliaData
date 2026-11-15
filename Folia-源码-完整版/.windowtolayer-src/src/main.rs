/* SPDX-License-Identifier: GPL-3.0-or-later */
use arrayvec::ArrayVec;
use lexopt::{Arg, ValueExt};
use log::{debug, Log, Record};
use rustix::{event, io, net};
use std::ffi::{OsStr, OsString};
use std::fmt::Write as FmtWrite;
use std::io::{IoSlice, IoSliceMut, Write as IoWrite};
use std::mem::MaybeUninit;
use std::os::fd::{AsFd, AsRawFd, BorrowedFd, FromRawFd, OwnedFd};
use std::process::Command;
use std::sync::Mutex;
use std::{env, os::fd::RawFd};
use windowtolayer::common::{
    MessageRewriter, ProcResult, WaylandError, FD_IN_QUEUE_SIZE, MAX_EARLY_FDS,
};
use windowtolayer::reverse::LayerToWindow;
use windowtolayer::state::WindowToLayer;
use windowtolayer::wayland::ZwlrLayerShellV1Layer;
use windowtolayer::wayland_util::{OutputQueue, FD_OUT_QUEUE_SIZE};

struct Logger {
    max_level: log::LevelFilter,
    cache: Mutex<String>,
}

static LOGGER: Logger = Logger {
    max_level: log::LevelFilter::Debug,
    /* A resizable cache to avoid allocating a new string on every debug message;
     * The maximum debug message size is bounded and is certainly <1MB, so this could
     * in theory be statically allocated. Since this program is single threaded (and
     * already grabs the stderr Mutex) the cost of this Mutex is negligible. */
    cache: Mutex::new(String::new()),
};

impl Log for Logger {
    fn enabled(&self, meta: &log::Metadata<'_>) -> bool {
        meta.level() <= self.max_level
    }
    fn log(&self, record: &Record<'_>) {
        if record.level() > self.max_level {
            return;
        }

        let time = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH);
        let t = if let Ok(t) = time {
            (t.as_nanos() % 100000000000u128) / 1000u128
        } else {
            0
        };
        let pid = std::process::id();

        let mut cache = self.cache.lock().unwrap();

        writeln!(
            &mut cache,
            "[{:02}.{:06} windowtolayer({}) {}:{}] {}",
            t / 1000000u128,
            t % 1000000u128,
            pid,
            record
                .file()
                .unwrap_or("src/unknown")
                .strip_prefix("src/")
                .unwrap(),
            record.line().unwrap_or(0),
            record.args(),
        )
        .unwrap();
        /* Write in one chunk; for small writes this ensures atomicity of messages
         * in the combined log stream of this and other applications */
        let handle = &mut std::io::stderr().lock();
        let _ = handle.write_all(cache.as_bytes());
        let _ = handle.flush();

        /* Empty string but do not deallocate it*/
        cache.clear();
    }
    fn flush(&self) {
        /* not needed */
    }
}

fn connect_to_unix_addr(
    upstream_fd: OwnedFd,
    addr: &net::SocketAddrUnix,
) -> Result<OwnedFd, &'static str> {
    let res = net::connect(&upstream_fd, addr);
    if res.is_ok() {
        Ok(upstream_fd)
    } else {
        Err("Failed to connect to WAYLAND_DISPLAY")
    }
}

fn connect_to_upstream() -> Result<OwnedFd, &'static str> {
    let env_disp = env::var_os("WAYLAND_DISPLAY");
    let env_sock = env::var_os("WAYLAND_SOCKET");
    let env_dir = env::var_os("XDG_RUNTIME_DIR");
    if let Some(sock) = env_sock {
        if let Some(fd) = sock.into_string().ok().and_then(|x| x.parse::<u16>().ok()) {
            // Capture inherited fd from environment variable
            // Must only call connect_to_upstream() once, at risk of closing random fd
            let upstream_fd = unsafe { OwnedFd::from_raw_fd(RawFd::from(fd)) };

            // todo: this validates the number is a file descriptor, and should error if invalid
            if set_cloexec(&upstream_fd, true) {
                Ok(upstream_fd)
            } else {
                Err("WAYLAND_SOCKET did not indicate a valid file descriptor")
            }
        } else {
            Err("Failed to parse WAYLAND_SOCKET")
        }
    } else if let Some(disp) = env_disp {
        let leading_slash: &[u8] = b"/";

        let upstream_fd = net::socket_with(
            net::AddressFamily::UNIX,
            net::SocketType::STREAM,
            net::SocketFlags::NONBLOCK,
            None,
        )
        .unwrap();
        set_cloexec(&upstream_fd, true);

        if disp.as_encoded_bytes().starts_with(leading_slash) {
            let addr = net::SocketAddrUnix::new(disp.as_os_str()).unwrap();
            connect_to_unix_addr(upstream_fd, &addr)
        } else if let Some(dir) = env_dir {
            let mut path = OsString::new();
            path.push(dir);
            path.push(OsString::from("/"));
            path.push(disp);
            let addr = net::SocketAddrUnix::new(path.as_os_str()).unwrap();
            connect_to_unix_addr(upstream_fd, &addr)
        } else {
            Err("XDG_RUNTIME_DIR was not in environment")
        }
    } else {
        Err("Neither WAYLAND_DISPLAY nor WAYLAND_SOCKET available")
    }
}

fn set_cloexec(fd: &OwnedFd, cloexec: bool) -> bool {
    io::fcntl_setfd(
        fd,
        if cloexec {
            io::FdFlags::CLOEXEC
        } else {
            io::FdFlags::empty()
        },
    )
    .is_ok()
}

fn read_from_socket(socket: &OwnedFd, bufs: &mut ProxySide) -> Result<(), String> {
    // assume the socket starts _empty_, for now
    if bufs.nbytes_src == bufs.buf_src.len() {
        panic!(
            "no remaining space: {} used, {} total",
            bufs.nbytes_src,
            bufs.buf_src.len()
        );
    }

    let mut iovs = [IoSliceMut::new(&mut bufs.buf_src[bufs.nbytes_src..])];
    let mut cmsg_fd_space = [MaybeUninit::<u8>::zeroed(); rustix::cmsg_space!(ScmRights(32))];
    let mut cmsg_fds = net::RecvAncillaryBuffer::new(&mut cmsg_fd_space);

    match net::recvmsg(socket, &mut iovs, &mut cmsg_fds, net::RecvFlags::empty()) {
        Ok(resp) => {
            bufs.nbytes_src += resp.bytes;
            let ctruncated = resp.flags.contains(net::ReturnFlags::CTRUNC);
            if ctruncated {
                return Err("Failed to read from socket: control data was truncated".to_string());
            }

            for msg in cmsg_fds.drain() {
                match msg {
                    net::RecvAncillaryMessage::ScmRights(tfds) => {
                        let init_len = bufs.fds_in.len();
                        bufs.fds_in.extend(tfds.rev());
                        bufs.fds_in.rotate_left(init_len);
                    }
                    _ => {
                        return Err("Received unexpected control message".to_string());
                    }
                }
            }

            Ok(())
        }
        Err(io::Errno::INTR) | Err(io::Errno::AGAIN) => {
            // Having no data (EAGAIN) for nonblocking FDs
            // is unexpected due to use of poll; but can safely ignore this.
            // For EINTR, we could retry in this a loop, but instead will
            // return OK and let the main loop handle retrying for us
            Ok(())
        }
        Err(e) => Err(format!("Error reading from socket: {:?}", e)),
    }
}

fn write_to_socket(socket: &OwnedFd, bufs: &mut ProxySide) -> Result<(), String> {
    // after writing, move bytes to front. todo: use a mutable-slice window?
    if bufs.nbytes_dst == 0 {
        panic!("write_to_socket called with no bytes to write");
    }
    let mut borrowed_fds: ArrayVec<BorrowedFd, MAX_EARLY_FDS> = ArrayVec::new();

    let max_fds_to_send = MAX_EARLY_FDS - bufs.early_fds_out.len();
    let (nbytes_sent, nfds_sent) = if max_fds_to_send >= bufs.fds_out.len() {
        /* Can safely send all fds, and thus can try to send all bytes */
        (bufs.nbytes_dst, bufs.fds_out.len())
    } else {
        /* Cannot send fd at position `max_fds_to_send`, so cannot send the byte
         * that would make the fd processable. */
        (bufs.fds_out[max_fds_to_send].1 - 1, max_fds_to_send)
    };
    assert!(nbytes_sent <= bufs.nbytes_dst);
    if nbytes_sent == 0 {
        panic!("overloaded: too many file descriptors concentrated at a byte position, cannot send all")
    }
    for f in &bufs.fds_out[..nfds_sent] {
        borrowed_fds.push(f.0.as_fd());
    }
    let iovs = [IoSlice::new(&bufs.buf_dst[..nbytes_sent])];

    let mut cmsgs_data = [MaybeUninit::<u8>::zeroed(); rustix::cmsg_space!(ScmRights(32))];
    let mut cmsgs = net::SendAncillaryBuffer::new(&mut cmsgs_data);
    assert!(cmsgs.push(net::SendAncillaryMessage::ScmRights(&borrowed_fds)));

    match net::sendmsg(socket, &iovs, &mut cmsgs, net::SendFlags::empty()) {
        Ok(s) => {
            // alt: move window up ; or rotate if using single-copy model
            bufs.buf_dst.copy_within(s..bufs.nbytes_dst, 0);
            bufs.nbytes_dst -= s;
            drop(borrowed_fds);

            /* Drop sent FDs, and store their positions in `early_fds_out`. */
            for (fd, pos) in bufs.fds_out.drain(..nfds_sent) {
                bufs.early_fds_out.push(pos);
                drop(fd);
            }
            for (_fd, pos) in bufs.fds_out.iter_mut() {
                *pos -= s;
            }

            /* Sending bytes lets the other process handle FDs sent earlier. */
            let mut n_early_fds_completed = 0;
            for pos in bufs.early_fds_out.iter_mut() {
                if *pos < s {
                    n_early_fds_completed += 1;
                } else {
                    *pos -= s;
                }
            }
            bufs.early_fds_out.drain(0..n_early_fds_completed);

            Ok(())
        }
        Err(io::Errno::INTR) | Err(io::Errno::AGAIN) => {
            // Having no space (EAGAIN) for nonblocking FDs
            // is unexpected due to use of poll; but can safely ignore this.
            // For EINTR, we could retry in this a loop, but instead will
            // return OK and let the main loop handle retrying for us
            Ok(())
        }
        Err(e) => Err(format!("Error writing to socket: {:?}", e)),
    }
}

struct ProxySide<'a> {
    buf_src: &'a mut [u8],
    nbytes_src: usize,
    buf_dst: &'a mut [u8],
    nbytes_dst: usize,
    fds_in: ArrayVec<OwnedFd, FD_IN_QUEUE_SIZE>,
    /** File descriptors queued to to be written, and the byte positions in `buf_dst`
     * at which they will be needed. */
    fds_out: ArrayVec<(OwnedFd, usize), FD_OUT_QUEUE_SIZE>,
    /** Positions of file descriptors which were sent before their corresponding
     * bytes in the output stream. */
    early_fds_out: ArrayVec<usize, MAX_EARLY_FDS>,
}

pub fn escape_non_ascii_printable(name: &[u8]) -> String {
    use std::fmt::Write;

    let mut s = String::new();
    for c in name {
        match *c {
            b' '..=b'~' => s.push(char::from_u32(*c as u32).unwrap()),
            _ => {
                write!(s, "\\x{:02x}", *c).unwrap();
            }
        }
    }
    s
}

fn log_messages(
    from_upstream: bool,
    state: &dyn MessageRewriter,
    mut msgs: &[u8],
    processed: bool,
) {
    while msgs.len() >= 8 {
        let oheader = u32::from_le_bytes(msgs[4..8].try_into().unwrap());
        let obyte_len = (oheader >> 16) as usize;
        assert!(msgs.len() >= obyte_len);
        state.log_message(&msgs[..obyte_len], from_upstream, processed);
        msgs = &msgs[obyte_len..];
    }
    assert!(msgs.is_empty());
}

fn process_messages(
    from_upstream: bool,
    bufs: &mut ProxySide,
    reverse: &mut ProxySide,
    state: &mut dyn MessageRewriter,
) -> Result<(), String> {
    // TODO: use a ring-type data structure to make zero-copying possible; to handle
    // long messages, use 100% overhang
    let mut ncopied = 0;
    let mut remaining = bufs.nbytes_src;
    while remaining >= 8 {
        // Steal first message
        let header = u32::from_le_bytes(bufs.buf_src[ncopied + 4..ncopied + 8].try_into().unwrap());
        let byte_len = (header >> 16) as usize;

        if byte_len % 4 != 0 {
            return Err("Failed to parse message: length not multiple of four".to_string());
        }
        if byte_len < 8 {
            return Err("Failed to parse message: too short".to_string());
        }
        if remaining < byte_len {
            // Partial message, do nothing.
            break;
        }
        let msg = &bufs.buf_src[ncopied..ncopied + byte_len];

        if log::log_enabled!(log::Level::Debug) {
            state.log_message(msg, from_upstream, false);
        }

        let dst_space = bufs.buf_dst.len();
        let mut dstq = OutputQueue {
            data: &mut bufs.buf_dst[bufs.nbytes_dst..],
            endpoint: dst_space,
            fds: &mut bufs.fds_out,
        };
        let dst_len = dstq.data.len();

        let rev_dst_space = reverse.buf_dst.len();
        let mut reverse_dstq = OutputQueue {
            data: &mut reverse.buf_dst[reverse.nbytes_dst..],
            endpoint: rev_dst_space,
            fds: &mut reverse.fds_out,
        };
        let rev_dst_len = reverse_dstq.data.len();
        let processed_message = state
            .process_message(
                from_upstream,
                msg,
                &mut bufs.fds_in,
                &mut dstq,
                &mut reverse_dstq,
            )
            .map_err(|e| match e {
                WaylandError::Parse => "Failed to parse messsage".into(),
                // TODO: protocol or logic error, send to client via wl_display::error
                WaylandError::Other(x) => x,
            });
        match processed_message {
            Ok(ProcResult::NeedsSpace(fwd_space, rev_space)) => {
                if fwd_space.0 > bufs.buf_dst.len()
                    || fwd_space.1 > bufs.fds_out.capacity()
                    || rev_space.0 > reverse.buf_dst.len()
                    || rev_space.1 > reverse.fds_out.capacity()
                {
                    return Err(format!(
                        "Insufficient space to write messages: forward data {} > {} fd {} > {}, reverse data {} > {} fd {} > {}",
                        fwd_space.0,
                        bufs.buf_dst.len(),
                        fwd_space.1,
                        bufs.fds_out.capacity(),
                        rev_space.0,
                        reverse.buf_dst.len(),
                        rev_space.1,
                        reverse.fds_out.capacity(),
                    ));
                }
                debug!("Waiting for output space");
                break;
            }
            Ok(ProcResult::WaitForOtherDirection) => {
                // TODO: handle this in the main loop to avoid busy-waiting if the
                // compositor takes a long time to send output name events
                debug!("Waiting for progress on the other direction");
                break;
            }
            Ok(ProcResult::Done) => (),
            Err(process_err) => {
                // Drop a single unprocessable message and keep going. Unsupported
                // requests such as xdg_wm_base::create_positioner / xdg_surface::get_popup
                // (used by popups and menus) must not tear down the whole layer: that
                // breaks the wrapped client's Wayland connection and crashes it.
                eprintln!("Ignoring unprocessable message: {}", process_err);
            }
        }
        let new_dst_len = dstq.data.len();
        let new_rev_dst_len = reverse_dstq.data.len();
        if log::log_enabled!(log::Level::Debug) {
            log_messages(
                from_upstream,
                state,
                &bufs.buf_dst[bufs.nbytes_dst..bufs.nbytes_dst + (dst_len - new_dst_len)],
                true,
            );
            log_messages(
                !from_upstream,
                state,
                &reverse.buf_dst
                    [reverse.nbytes_dst..reverse.nbytes_dst + (rev_dst_len - new_rev_dst_len)],
                true,
            );
        }
        bufs.nbytes_dst += dst_len - new_dst_len;
        reverse.nbytes_dst += rev_dst_len - new_rev_dst_len;

        // Mark message as having been read
        ncopied += byte_len;
        remaining -= byte_len;
    }

    bufs.buf_src.copy_within(ncopied..bufs.nbytes_src, 0);
    bufs.nbytes_src -= ncopied;

    Ok(())
}

const USAGE: &str = r"Usage: windowtolayer [OPTIONS] <command>...
Translates xdg-shell wayland client to use wlr-layer-shell

Arguments:
  <command>...  Command to run

Options:
  --dummy-seat              Workaround to expose a blank wl_seat if clients need one to be present
  -l, --layer <L>           Set the layer at which to display the application
                            [default: background] [possible values: background, bottom, top, overlay]
  -i, --interactivity <I>   What type of interaction is permitted [default: none]
                            [possible values: none, pointer, keyboard, all]
  -z, --exclusive-zone <Z>  Set the layer surface exclusive zone value [default: -1]
  -m, --maximized           Notify application that it is maximized (must fill entire output)
  --output-name <name>      Choose the name of the output to use; by default the compositor decides.

  -r, --reverse             Map wlr-layer-shell to xdg-shell, instead. Incompatible with -l, -i, -z, -m.
  --wle-embedding-token <r> If using --reverse, use wle_embedding_v1 protocol with given token.

  --one-client              Removes WAYLAND_DISPLAY env variable, leaving only WAYLAND_SOCKET

  -d, --debug               Log debug messages
  -h, --help                Print help
  -V, --version             Print version";

const VERSION: &str = env!("CARGO_PKG_VERSION");

const ON_USAGE_ERROR: &str = "For more information, see `windowtolayer --help`";

macro_rules! command_line_error {
    ($x:tt) => {
        command_line_error_start();
        eprintln!($x);
        command_line_error_end();
    };
    ($x:tt, $($arg:tt)+) => {
        command_line_error_start();
        eprintln!($x, $($arg)+);
        command_line_error_end();
    };
}

#[cold]
fn command_line_error_start() {
    eprintln!(
        "In command line arguments: {:?}",
        std::env::args_os().collect::<Vec<OsString>>()
    );
}
fn command_line_error_end() -> ! {
    eprintln!("{}", ON_USAGE_ERROR);
    std::process::exit(1);
}

fn check_no_option(parser: &mut lexopt::Parser, argument: &str) {
    if let Some(v) = parser.optional_value() {
        command_line_error!("Unexpected optional value {:?} for {}", v, argument);
    }
}

fn get_option(parser: &mut lexopt::Parser, argument: &str) -> OsString {
    if let Ok(v) = parser.value() {
        v
    } else {
        command_line_error!("Missing argument for {}", argument);
    }
}

fn main() {
    let mut debug = false;
    let mut interactivity: Option<(bool, bool)> = None;
    let mut layer: Option<ZwlrLayerShellV1Layer> = None;
    let mut one_client = false;
    let mut maximized = false;
    let mut reverse = false;
    let mut dummy_seat = false;
    let mut target_output: Option<String> = None;
    let mut wle_embedding_token: Option<String> = None;
    let mut zone: Option<i32> = None;
    let mut command: Vec<&OsStr> = Vec::new();

    /* Use lexopt here, instead of clap, to save ~200-400kB of disk space (which at 100MB/sec
     * disk speed, amount to 2-4 ms of cold startup time.). (On a reasonably but not extremely
     * fast machine with an SSD, a 700kB executable with lexopt took in 5.8 msec to evaluate
     * --help, while a 1000kB executable using clap took 8.1 msec.) */
    let mut parser = lexopt::Parser::from_env();
    let mut first_val: Option<OsString> = None;
    while let Ok(Some(arg)) = parser.next() {
        match arg {
            Arg::Short('h') | Arg::Long("help") => {
                if matches!(arg, Arg::Long(_)) {
                    check_no_option(&mut parser, "--help");
                }
                println!("{}", USAGE);
                return;
            }
            Arg::Short('V') | Arg::Long("version") => {
                if matches!(arg, Arg::Long(_)) {
                    check_no_option(&mut parser, "--version");
                }
                println!("{}", VERSION);
                return;
            }
            Arg::Short('m') | Arg::Long("maximized") => {
                if matches!(arg, Arg::Long(_)) {
                    check_no_option(&mut parser, "--maximized");
                }
                maximized = true;
            }
            Arg::Short('r') | Arg::Long("reverse") => {
                if matches!(arg, Arg::Long(_)) {
                    check_no_option(&mut parser, "--reverse");
                }
                reverse = true;
            }
            Arg::Short('d') | Arg::Long("debug") => {
                if matches!(arg, Arg::Long(_)) {
                    check_no_option(&mut parser, "--debug");
                }
                debug = true;
            }
            Arg::Long("dummy-seat") => {
                check_no_option(&mut parser, "--dummy-seat");
                dummy_seat = true;
            }
            Arg::Long("output-name") => {
                target_output = if let Ok(y) =
                    get_option(&mut parser, "--output-name").into_string()
                {
                    Some(y)
                } else {
                    command_line_error!("Argument for --output-name is not a valid UTF-8 string");
                }
            }
            Arg::Long("wle-embedding-token") => {
                wle_embedding_token =
                    if let Ok(y) = get_option(&mut parser, "--wle-embedding-token").into_string() {
                        Some(y)
                    } else {
                        command_line_error!(
                            "Argument for --wle-embedding-token is not a valid UTF-8 string"
                        );
                    };
            }
            Arg::Short('z') | Arg::Long("exclusive_zone") | Arg::Long("exclusive-zone") => {
                let s = get_option(&mut parser, "--exclusive-zone");
                zone = Some(if let Ok(y) = s.parse::<i32>() {
                    y
                } else {
                    command_line_error!("Argument {:?} for --exclusive-zone could not be parsed as an integer or is out of range", s);
                });
            }
            Arg::Short('i') | Arg::Long("interactivity") => {
                let s = get_option(&mut parser, "--interactivity");
                interactivity = Some(match s.to_str() {
                    Some("none") => (false, false),
                    Some("pointer") => (false, true),
                    Some("keyboard") => (true, false),
                    Some("all") => (true, true),
                    _ => {
                        command_line_error!("Argument {:?} for --interactivity is not in the list [none, pointer, keyboard, all]", s);
                    }
                });
            }
            Arg::Short('l') | Arg::Long("layer") => {
                let s = get_option(&mut parser, "--layer");
                layer = Some(match s.to_str() {
                    Some("background") => ZwlrLayerShellV1Layer::Background,
                    Some("bottom") => ZwlrLayerShellV1Layer::Bottom,
                    Some("top") => ZwlrLayerShellV1Layer::Top,
                    Some("overlay") => ZwlrLayerShellV1Layer::Overlay,
                    _ => {
                        command_line_error!("Argument {:?} for --layer is not in the list [background, bottom, top, overlay]", s);
                    }
                });
            }
            Arg::Long("one-client") => {
                one_client = true;
            }
            Arg::Long(l) => {
                command_line_error!("Invalid long argument --{}", l);
            }
            Arg::Short(c) => {
                command_line_error!("Invalid short argument -{}", c);
            }

            Arg::Value(v) => {
                first_val = Some(v);
                break;
            }
        }
    }
    if let Some(ref v) = first_val {
        command.push(v.as_os_str());
    }

    let trailing_args = parser.raw_args();
    match trailing_args {
        Err(_) => {
            command_line_error!("Leftover unhandled argument");
        }
        Ok(ref x) => {
            for y in x.as_slice() {
                command.push(y.as_os_str());
            }
        }
    };
    if command.is_empty() {
        command_line_error!("Missing required argument <command>");
    }

    if reverse {
        if maximized || layer.is_some() || interactivity.is_some() || zone.is_some() || dummy_seat {
            command_line_error!("--reverse mode is incompatible with --maximized, --layer, --interactivity, --exclusive_zone, --dummy-seat");
        }
    } else if wle_embedding_token.is_some() {
        command_line_error!("--wle-embedding_token only available in --reverse mode");
    }
    let layer = layer.unwrap_or(ZwlrLayerShellV1Layer::Background);
    let (kbd_int, mouse_int) = interactivity.unwrap_or((false, false));
    let zone = zone.unwrap_or(-1);

    log::set_max_level(if debug {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Error
    });
    log::set_logger(&LOGGER).unwrap();

    let conn_result = connect_to_upstream();
    let upstream_fd: OwnedFd = match conn_result {
        Ok(x) => x,
        Err(y) => {
            eprintln!("{}", y);
            return;
        }
    };

    let (downstream_fd, inherited_fd) = net::socketpair(
        net::AddressFamily::UNIX,
        net::SocketType::STREAM,
        net::SocketFlags::NONBLOCK,
        None,
    )
    .unwrap();
    set_cloexec(&downstream_fd, true);
    set_cloexec(&inherited_fd, false);
    let fd_str = inherited_fd.as_raw_fd().to_string();
    debug!(
        "Spawning program {:?} with args: {:?}",
        command[0],
        &command[1..]
    );
    /* WAYLAND_SOCKET should have priority over WAYLAND_DISPLAY,
     * so the command should connect to the proxy. If the command
     * incorrectly picks WAYLAND_DISPLAY, it may render as a normal window,
     * and recursively spawned programs may break if the command
     * does not clear WAYLAND_SOCKET. */
    let mut cmd = Command::new(command[0]);
    cmd.args(&command[1..]).env("WAYLAND_SOCKET", fd_str);
    if one_client {
        cmd.env_remove("WAYLAND_DISPLAY");
    }
    let mut handle = match cmd.spawn() {
        Ok(h) => h,
        Err(e) => {
            eprintln!(
                "Failed to run program {:?} with args {:?}: {}",
                command[0],
                &command[1..],
                e
            );
            std::process::exit(1);
        }
    };
    drop(inherited_fd);

    // Step 3: forward messages in each direction
    let mut bufs_upward = ProxySide {
        buf_src: &mut [0_u8; 4096],
        buf_dst: &mut [0_u8; 4096],
        fds_in: ArrayVec::new(),
        fds_out: ArrayVec::new(),
        early_fds_out: ArrayVec::new(),
        nbytes_src: 0,
        nbytes_dst: 0,
    };
    let mut bufs_downward = ProxySide {
        buf_src: &mut [0_u8; 4096],
        buf_dst: &mut [0_u8; 4096],
        fds_in: ArrayVec::new(),
        fds_out: ArrayVec::new(),
        early_fds_out: ArrayVec::new(),
        nbytes_src: 0,
        nbytes_dst: 0,
    };
    let state: &mut dyn MessageRewriter = if reverse {
        &mut LayerToWindow::new(
            target_output.as_deref().unwrap_or("O-1"),
            wle_embedding_token.as_deref(),
        )
    } else {
        &mut WindowToLayer::new(
            layer,
            zone,
            kbd_int,
            mouse_int,
            maximized,
            target_output.as_deref(),
            dummy_seat,
        )
    };

    loop {
        let writing_up = bufs_upward.nbytes_dst > 0;
        assert!(bufs_upward.fds_out.is_empty() || writing_up);
        let writing_down = bufs_downward.nbytes_dst > 0;
        assert!(bufs_downward.fds_out.is_empty() || writing_down);
        let mut pfds = [
            event::PollFd::new(
                &downstream_fd,
                if writing_down {
                    event::PollFlags::OUT
                } else {
                    event::PollFlags::IN
                },
            ),
            event::PollFd::new(
                &upstream_fd,
                if writing_up {
                    event::PollFlags::OUT
                } else {
                    event::PollFlags::IN
                },
            ),
        ];
        match event::poll(&mut pfds, None) {
            Ok(_) => {}
            Err(e) => {
                eprintln!("Poll error {}", e);
                continue;
            }
        };

        let down_evts = pfds[0].revents();
        let up_evts = pfds[1].revents();

        if down_evts.contains(event::PollFlags::HUP) {
            debug!("Downstream hang up");
            break;
        } else if down_evts.contains(event::PollFlags::ERR) {
            debug!("Downstream error up");
            break;
        } else if writing_down && down_evts.contains(event::PollFlags::OUT) {
            if let Err(x) = write_to_socket(&downstream_fd, &mut bufs_downward) {
                eprintln!("{}", x);
                break;
            }
            // Process messages in the src buffer which were waiting to be translated
            // to the dst buffer (but which did not have enough free space)
            if let Err(x) = process_messages(true, &mut bufs_downward, &mut bufs_upward, state) {
                eprintln!("{}", x);
                break;
            }
        } else if !writing_down && !writing_up && down_evts.contains(event::PollFlags::IN) {
            if let Err(x) = read_from_socket(&downstream_fd, &mut bufs_upward) {
                eprintln!("{}", x);
                break;
            }
            if let Err(x) = process_messages(false, &mut bufs_upward, &mut bufs_downward, state) {
                eprintln!("{}", x);
                break;
            }
        }

        if up_evts.contains(event::PollFlags::HUP) {
            debug!("Upstream hang up");
            break;
        } else if up_evts.contains(event::PollFlags::ERR) {
            debug!("Upstream error up");
            break;
        } else if writing_up && up_evts.contains(event::PollFlags::OUT) {
            if let Err(x) = write_to_socket(&upstream_fd, &mut bufs_upward) {
                eprintln!("{}", x);
                break;
            }
            // Process messages in the src buffer which were waiting to be translated
            // to the dst buffer (but which did not have enough free space)
            if let Err(x) = process_messages(false, &mut bufs_upward, &mut bufs_downward, state) {
                eprintln!("{}", x);
                break;
            }
        } else if !writing_up && !writing_down && up_evts.contains(event::PollFlags::IN) {
            if let Err(x) = read_from_socket(&upstream_fd, &mut bufs_downward) {
                eprintln!("{}", x);
                break;
            }
            if let Err(x) = process_messages(true, &mut bufs_downward, &mut bufs_upward, state) {
                eprintln!("{}", x);
                break;
            }
        }
    }

    debug!("Waiting for program to exit");
    let _ = handle.try_wait();
    debug!("Done");
}
