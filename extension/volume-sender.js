// One request at a time keeps older values from overtaking the final value.
function createVolumeSender(send, onError, intervalMs = 100) {
  let pending = null;
  let timer = null;
  let sending = false;
  let stopped = false;
  let finalRequested = false;
  let lastSentAt = -Infinity;

  function cancel() {
    stopped = true;
    pending = null;
    clearTimeout(timer);
    timer = null;
  }

  function schedule() {
    if (stopped || sending || pending === null || timer !== null) return;
    let delay = finalRequested ? 0 : Math.max(0, intervalMs - (performance.now() - lastSentAt));
    timer = setTimeout(deliver, delay);
  }

  async function deliver() {
    timer = null;
    if (stopped || pending === null) return;
    let value = pending;
    pending = null;
    finalRequested = false;
    sending = true;
    lastSentAt = performance.now();
    try {
      await send(value);
    } catch (error) {
      cancel();
      onError(error);
    } finally {
      sending = false;
      schedule();
    }
  }

  return {
    push(value) {
      if (stopped) return;
      pending = value;
      schedule();
    },
    flush(value) {
      if (stopped) return;
      pending = value;
      // The committed value bypasses the throttle delay, but still waits for an in-flight request.
      finalRequested = true;
      clearTimeout(timer);
      timer = null;
      schedule();
    },
    cancel
  };
}
