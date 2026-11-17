// harmony/folia/entry/src/main/ets/bridge/FoliaBridgeOptions.ets
//
// 桥入参的取值辅助。
//
// 为什么用 ESObject 而不是 Record<string, Object>：
// ArkTS 严格模式下 `Object` 不能作泛型实参（arkts-no-any-unknown），
// 写成 `Record<string, Object>` 会在函数参数标注处直接编译失败。
// ESObject 是 ArkTS 官方给动态 JSON 用的类型，索引访问合法。
//
// 为什么不在类型位置也统一用 ESObject：
// `Record<string, Object>` 在 interface / type 别名位置是可以的（已实测），
// 保持它能让 BridgeRequest 与 Handler 的形状更明确。

/** 从桥入参里取字符串，取不到或类型不对时返回空串。 */
export function optString(o: ESObject, key: string): string {
  const v: ESObject = o[key];
  return typeof v === 'string' ? v : '';
}

/** 从桥入参里取数字，取不到或不是有限数时返回 0。 */
export function optNumber(o: ESObject, key: string): number {
  const v: ESObject = o[key];
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string') {
    const n: number = Number(v);
    if (isFinite(n)) return n;
  }
  return 0;
}

/** 从桥入参里取布尔。 */
export function optBool(o: ESObject, key: string): boolean {
  const v: ESObject = o[key];
  return v === true;
}

/** 取一个可选字符串字段；字段不存在时返回空串（区别于「有值但为空」）。 */
export function optStringOrUndefined(o: ESObject, key: string): string | undefined {
  if (o === undefined || o === null) return undefined;
  const v: ESObject = o[key];
  return typeof v === 'string' ? v : undefined;
}
