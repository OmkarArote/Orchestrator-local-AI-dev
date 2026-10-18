'use strict';
// One heavy-media job at a time, shared with the local-task lane. Callers that already hold it must not call occupy.
let held = 0;
const waiters = [];

function heldNow() { return held > 0; }
function hold() { held += 1; }
function release() {
  held = Math.max(0, held - 1);
  if (!held && waiters.length) waiters.shift()();
}
function occupy(fn) {
  return new Promise((resolve, reject) => {
    const start = () => {
      if (heldNow()) { waiters.push(start); return; }
      hold();
      Promise.resolve().then(fn).then((v) => { release(); resolve(v); }, (e) => { release(); reject(e); });
    };
    start();
  });
}

module.exports = { heldNow, hold, release, occupy };
