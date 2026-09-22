// Agent Runtime V1（Stage 2.1）— 异步队列：回调 → 生成器
//
// 从 `session.ts` 拆出。拆分理由：
//   `session.ts` 原本同时承担「Agent 生命周期编排」与「回调到生成器的桥接」两件事，
//   而后者是可独立测试的纯机制，与 Agent、隐私、工具都无关。
//   拆开后 session.ts 只负责编排，本模块只负责搬运事件。
//
// ⚠️ 行为与拆分前**完全一致**（逻辑原样搬迁，未改动语义）。

/**
 * 一个最小的一次性异步队列。
 *
 * 语义（拆出前踩过两次坑，这里明确定义，改动前请先读）：
 *   * `push()` 入队并唤醒等待者；`close()` 置为关闭并唤醒等待者。
 *   * `drain()` 只吐当前已缓冲的元素，**缓冲为空时立刻返回** —— 不阻塞等待新元素。
 *   * `waitForWork()` 等待"有新元素或已关闭"。
 *
 * 为什么把等待拆出来（而不是让 drain 自己挂起）：
 *   若 `drain()` 在缓冲为空时自己挂起，那么「生产者在 await 之后才 emit」的场景下，
 *   消费者会卡在一个**不会再被唤醒**的 promise 上（生产者只唤醒自己那套信号），
 *   表现为 5 秒超时死锁。拆开后，消费者可以用 `runSettled` 这类外部条件
 *   决定何时停止等待（见 session.ts 的驱动循环）。
 */
export function createAsyncQueue<T>() {
  const buffer: T[] = [];
  let closed = false;
  let wake: (() => void) | null = null;

  const notify = () => {
    const pending = wake;
    wake = null;
    if (pending) pending();
  };

  return {
    push(value: T) {
      if (closed) return;
      buffer.push(value);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    get isClosed() {
      return closed;
    },
    /** 吐出当前已缓冲的元素；缓冲为空即返回（不等待）。 */
    *drain(): Generator<T, void, undefined> {
      while (buffer.length > 0) yield buffer.shift() as T;
    },
    /** 等待"有新元素或已关闭"。 */
    waitForWork(): Promise<void> {
      if (buffer.length > 0 || closed) return Promise.resolve();
      return new Promise<void>(resolve => { wake = resolve; });
    },
  };
}

/** 队列的公开形状（供 session.ts 标注类型，避免 any）。 */
export type AsyncQueue<T> = ReturnType<typeof createAsyncQueue<T>>;
