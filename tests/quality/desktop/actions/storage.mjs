// Quality Harness V2 — 测试侧 localStorage 读写（E2E-007 重启持久化）
//
// 从 V1 的 actions.mjs 中拆出（V2 要求「单文件不超过 300 行」）。
// 只操作 WebView2 的 localStorage，不碰任何业务成本字段。

/** 读取一个 localStorage 值。 */
export async function readLocalStorage(cdp, key) {
  return cdp.evaluate(`window.localStorage.getItem(${JSON.stringify(key)})`);
}

/** 写入一个 localStorage 值，并回读确认。 */
export async function writeLocalStorage(cdp, key, value) {
  return cdp.evaluate(
    `(() => {
      window.localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)});
      return window.localStorage.getItem(${JSON.stringify(key)});
    })()`,
  );
}
