// src/services/onlineMusic/appleMusicProvider.ts
// [apple-music] 上游主线用工厂函数 createAppleMusicProvider(getAvailability) 造 provider，
// 是为了在测试里注入可用性判定。本仓库的契约闸门 ci/contracts/extract.ts 要求每个注册进
// providerRegistry 的 provider 是「带顶层 id 的对象字面量导出」，工厂形式静态解析不了。
// 所以在这里把工厂物化成实例：展开出来的都是不依赖 this 的函数属性，行为与上游一致。
import type { OnlineMusicProvider } from '../../types/onlineMusic';
import { createAppleMusicProvider } from './appleMusic/appleMusicProvider';
import { getAppleMusicTransportAvailability } from './appleMusic/appleMusicTransport';

export const appleMusicProvider: OnlineMusicProvider = {
    ...createAppleMusicProvider(getAppleMusicTransportAvailability),
    id: 'appleMusic',
};
