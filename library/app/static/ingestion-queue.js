(function attachRagIngestionQueue(root) {
  "use strict";

  async function runSequentialQueue(items, processItem) {
    if (!Array.isArray(items)) throw new TypeError("items must be an array");
    if (typeof processItem !== "function") throw new TypeError("processItem must be a function");

    const outcomes = [];
    for (let index = 0; index < items.length; index += 1) {
      try {
        const value = await processItem(items[index], index);
        outcomes.push({ status: "fulfilled", value });
      } catch (reason) {
        outcomes.push({ status: "rejected", reason });
      }
    }
    return outcomes;
  }

  root.RagIngestionQueue = Object.freeze({ runSequentialQueue });
})(globalThis);
