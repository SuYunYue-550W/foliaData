// 极简 MQTT 3.1.1 编解码：公共中继能通的前提是字节层正确。
import { describe, expect, it } from 'vitest';
import {
    encodeConnect, encodeSubscribe, encodePublish, encodePingReq, encodeDisconnect,
    encodeRemainingLength, encodeMqttString, parseMqttPackets,
} from '../../../src/services/jam/jamMqtt';

const bytes = (...values: number[]) => new Uint8Array(values) as Uint8Array<ArrayBuffer>;

describe('MQTT remaining length', () => {
    it('encodes single-byte lengths', () => {
        expect(Array.from(encodeRemainingLength(0))).toEqual([0]);
        expect(Array.from(encodeRemainingLength(127))).toEqual([127]);
    });
    it('encodes multi-byte lengths (7-bit continuation)', () => {
        expect(Array.from(encodeRemainingLength(128))).toEqual([0x80, 0x01]);
        expect(Array.from(encodeRemainingLength(321))).toEqual([0xc1, 0x02]);
        expect(Array.from(encodeRemainingLength(268435455))).toEqual([0xff, 0xff, 0xff, 0x7f]);
    });
});

describe('MQTT string', () => {
    it('prefixes the UTF-8 byte length', () => {
        expect(Array.from(encodeMqttString('MQTT'))).toEqual([0, 4, 77, 81, 84, 84]);
        const utf8 = encodeMqttString('封面');
        expect(utf8[0]).toBe(0);
        expect(utf8[1]).toBe(6); // 两个汉字各 3 字节
        expect(utf8.length).toBe(8);
    });
});

describe('MQTT packets', () => {
    it('CONNECT starts with 0x10 and the MQTT 3.1.1 header', () => {
        const packet = encodeConnect('folia-test');
        expect(packet[0]).toBe(0x10);
        // 变长头 + 固定头 10 字节 + clientId('folia-test'=10) = 剩余长度 22
        expect(Array.from(packet.slice(0, 12))).toEqual([
            0x10, 22, 0, 4, 77, 81, 84, 84, 4, 0x02, 0, 0x3c,
        ]);
    });

    it('SUBSCRIBE uses type 8 with flags 0x02 and QoS0', () => {
        const packet = encodeSubscribe('folia/jam/v1/abc');
        expect(packet[0]).toBe(0x82);
        expect(packet[packet.length - 1]).toBe(0); // requested QoS 0
    });

    it('PUBLISH round-trips through the parser (topic + payload)', () => {
        const topic = 'folia/jam/v1/deadbeef';
        const payload = bytes(1, 2, 3, 250, 255);
        const packet = encodePublish(topic, payload);
        expect(packet[0]).toBe(0x30);
        const { packets, rest } = parseMqttPackets(packet);
        expect(rest.length).toBe(0);
        expect(packets).toHaveLength(1);
        expect(packets[0].type).toBe(3);
        expect(packets[0].topic).toBe(topic);
        expect(Array.from(packets[0].payload ?? [])).toEqual([1, 2, 3, 250, 255]);
    });

    it('PINGREQ / DISCONNECT are two-byte packets', () => {
        expect(Array.from(encodePingReq())).toEqual([0xc0, 0]);
        expect(Array.from(encodeDisconnect())).toEqual([0xe0, 0]);
    });
});

describe('MQTT stream parser', () => {
    it('splits coalesced packets and keeps an incomplete trailing packet', () => {
        // 两个完整的零长度包 + 一个明确不完整的 PUBLISH 头（声明 5 字节 body，实际只到 1 字节）。
        const stream = bytes(0xd0, 0x00, 0xc0, 0x00, 0x30, 0x05, 0x00, 0x02);
        const { packets, rest } = parseMqttPackets(stream);
        expect(packets.map(p => p.type)).toEqual([13, 12]);
        expect(Array.from(rest)).toEqual([0x30, 0x05, 0x00, 0x02]); // 留到下一次拼包
    });

    it('parses CONNACK return code', () => {
        const { packets } = parseMqttPackets(bytes(0x20, 0x02, 0x00, 0x00));
        expect(packets[0].type).toBe(2);
        expect(packets[0].returnCode).toBe(0);
    });

    it('rejects a malformed remaining-length field without throwing', () => {
        const { packets, rest } = parseMqttPackets(bytes(0x30, 0xff, 0xff, 0xff, 0xff, 0x7f));
        expect(packets).toHaveLength(0);
        expect(rest.length).toBeGreaterThan(0);
    });
});
