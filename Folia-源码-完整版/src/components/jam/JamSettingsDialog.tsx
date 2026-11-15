import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Segmented, Status, TextField, useSettingsKitTheme } from '../modal/settings/kit';
import ThemedDialog from '../shared/ThemedDialog';
import { createJamRoom, joinJamRoom, leaveJamRoom } from '../../services/jam/jamSession';
import { closeJamPanel, useJamStore } from '../../services/jam/jamStore';
import { isJamAvailable } from '../../services/jam/jamTransport';
import {
    getJamEndpointConfig, normalizeLanUrl, saveJamEndpointConfig, type JamEndpointMode,
} from '../../services/jam/jamEndpoint';
import { getJamLanHostAddresses, hasJamLanHostBridge } from '../../services/jam/jamRelayTransport';

// src/components/jam/JamSettingsDialog.tsx
// 「一起听」面板：连接端点选择 + 创建房间（短码 + 复制）/ 用短码加入 / 退出 + 状态与成员数。
//
// 常驻全局浮层（AppDialogs），入口在播放页面板的 account 页；不依赖设置弹窗是否打开。
// 默认走内置公共中继，手机与电脑都零部署；同一 WiFi 可切「局域网」直连电脑端内置服务。

const connectionLabel = (state: string, t: (key: string) => string): string => {
    switch (state) {
        case 'connected': return t('jam.stateConnected');
        case 'connecting': return t('jam.stateConnecting');
        case 'reconnecting': return t('jam.stateReconnecting');
        case 'closed': return t('jam.stateClosed');
        default: return t('jam.stateIdle');
    }
};

const errorLabel = (code: string, t: (key: string) => string): string => {
    if (code === 'room_not_found') return t('jam.errorRoomNotFound');
    if (code === 'jam_not_configured') return t('jam.errorNotConfigured');
    if (code === 'jam_lan_not_configured') return t('jam.errorLanNotConfigured');
    if (code === 'jam_lan_timeout' || code === 'jam_lan_socket') return t('jam.errorLanUnreachable');
    if (code === 'jam_relay_unavailable' || code === 'jam_relay_timeout') return t('jam.errorRelayUnreachable');
    return t('jam.errorGeneric');
};

const MODE_KEYS: ReadonlyArray<{ value: JamEndpointMode; key: string }> = [
    { value: 'public', key: 'jam.modePublic' },
    { value: 'lan', key: 'jam.modeLan' },
    { value: 'selfhost', key: 'jam.modeSelfhost' },
];

export const JamSettingsDialog: React.FC = () => {
    const { t } = useTranslation();
    const { isDaylight } = useSettingsKitTheme();
    const isOpen = useJamStore(state => state.uiOpen);
    const role = useJamStore(state => state.role);
    const roomCode = useJamStore(state => state.roomCode);
    const connection = useJamStore(state => state.connection);
    const memberCount = useJamStore(state => state.memberCount);
    const lastError = useJamStore(state => state.lastError);
    const [joinCode, setJoinCode] = useState('');
    const [busy, setBusy] = useState(false);
    const [endpoint, setEndpoint] = useState(() => getJamEndpointConfig());
    const [lanAddresses, setLanAddresses] = useState<string[]>([]);

    const isDesktopHost = hasJamLanHostBridge();
    const configured = isJamAvailable();
    const active = role !== null && roomCode !== null;

    // 桌面端且已创建房间时，拉一次内置中继地址供手机扫码/手填。
    useEffect(() => {
        if (!isOpen || !isDesktopHost || endpoint.mode !== 'lan' || !active) return;
        let cancelled = false;
        void getJamLanHostAddresses().then(list => { if (!cancelled) setLanAddresses(list); });
        return () => { cancelled = true; };
    }, [isOpen, isDesktopHost, endpoint.mode, active]);

    const handleModeChange = (mode: JamEndpointMode) => {
        const next = { ...endpoint, mode };
        setEndpoint(next);
        saveJamEndpointConfig(next);
    };

    const handleLanUrlChange = (value: string) => {
        setEndpoint(previous => ({ ...previous, lanUrl: value }));
    };

    const commitLanUrl = () => {
        const next = { ...endpoint, lanUrl: normalizeLanUrl(endpoint.lanUrl) };
        setEndpoint(next);
        saveJamEndpointConfig(next);
    };

    const handleClose = () => { closeJamPanel(); };

    const handleCreate = async () => {
        setBusy(true);
        await createJamRoom();
        setBusy(false);
    };

    const handleJoin = async () => {
        const code = joinCode.trim().toUpperCase();
        if (code.length !== 6) return;
        setBusy(true);
        await joinJamRoom(code);
        setBusy(false);
    };

    const handleLeave = async () => {
        setBusy(true);
        await leaveJamRoom();
        setBusy(false);
    };

    return (
        <ThemedDialog
            isOpen={isOpen}
            onClose={handleClose}
            isDaylight={isDaylight}
            title={t('jam.title')}
            size="m"
            footer={active ? (
                <Button onClick={() => void handleLeave()} disabled={busy}>
                    {t('jam.leave')}
                </Button>
            ) : null}
        >
            <div className="space-y-4 text-sm">
                {/* 连接端点：三种通道都免部署（自建为高级选项）。活动中不允许改，避免中途换汇合点。 */}
                <div className="space-y-2">
                    <p className="font-medium">{t('jam.endpointTitle')}</p>
                    <Segmented
                        value={endpoint.mode}
                        options={MODE_KEYS.map(item => ({ value: item.value, label: t(item.key) }))}
                        onChange={handleModeChange}
                        disabled={active}
                        fill
                    />
                    <p className="text-[11px] leading-4 opacity-70">{t(`jam.modeHint_${endpoint.mode}`)}</p>
                </div>

                {endpoint.mode === 'lan' ? (
                    <div className="space-y-2">
                        {isDesktopHost ? (
                            <>
                                <p className="opacity-80">{t('jam.lanHostHint')}</p>
                                {lanAddresses.length ? lanAddresses.map(address => (
                                    <div key={address} className="flex items-center justify-between gap-2">
                                        <code className="text-xs">{address}</code>
                                        <Button onClick={() => void navigator.clipboard?.writeText(address)}>
                                            {t('jam.copyCode')}
                                        </Button>
                                    </div>
                                )) : <p className="text-[11px] opacity-60">{t('jam.lanHostIdle')}</p>}
                            </>
                        ) : (
                            <>
                                <p className="opacity-80">{t('jam.lanGuestHint')}</p>
                                <TextField
                                    value={endpoint.lanUrl}
                                    onChange={handleLanUrlChange}
                                    onCommit={commitLanUrl}
                                    placeholder="ws://192.168.1.8:45331"
                                    disabled={active}
                                />
                            </>
                        )}
                    </div>
                ) : null}

                {endpoint.mode === 'selfhost' && !configured ? (
                    <div className="space-y-1">
                        <p>{t('jam.notConfigured')}</p>
                        <p className="text-[11px] leading-4 opacity-70">{t('jam.notConfiguredWhere')}</p>
                    </div>
                ) : null}

                {active ? (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between gap-3">
                            <span>{t('jam.roomCode')}</span>
                            <code className="text-lg font-mono tracking-widest">{roomCode}</code>
                            <Button onClick={() => void navigator.clipboard?.writeText(roomCode ?? '')}>
                                {t('jam.copyCode')}
                            </Button>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <span>{t('jam.yourRole')}{role === 'host' ? t('jam.roleHost') : t('jam.roleGuest')}</span>
                            <Status tone={connection === 'connected' ? 'ok' : connection === 'closed' ? 'error' : undefined}>
                                {connectionLabel(connection, t)}
                            </Status>
                        </div>
                        <div className="flex items-center justify-between gap-3">
                            <span>{t('jam.memberCount')}</span>
                            <span>{memberCount}</span>
                        </div>
                        {role === 'guest' ? <p className="opacity-70">{t('jam.guestHint')}</p> : null}
                    </div>
                ) : (
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <p className="font-medium">{t('jam.createTitle')}</p>
                            <Button variant="primary" onClick={() => void handleCreate()} disabled={busy || !configured}>
                                {busy ? t('jam.working') : t('jam.create')}
                            </Button>
                            <p className="opacity-70">{t('jam.createHint')}</p>
                        </div>
                        <div className="space-y-2">
                            <p className="font-medium">{t('jam.joinTitle')}</p>
                            <div className="flex items-center gap-2">
                                <TextField
                                    value={joinCode}
                                    onChange={(value) => setJoinCode(value.toUpperCase())}
                                    placeholder="ABC234"
                                />
                                <Button onClick={() => void handleJoin()} disabled={busy || !configured || joinCode.trim().length !== 6}>
                                    {t('jam.join')}
                                </Button>
                            </div>
                        </div>
                        {connection === 'closed' ? <Status tone="error">{t('jam.stateClosed')}</Status> : null}
                        {lastError ? <Status tone="error">{errorLabel(lastError, t)}</Status> : null}
                    </div>
                )}
            </div>
        </ThemedDialog>
    );
};

export default JamSettingsDialog;
