// scripts/tests/fake-clock.mjs
// Preloaded via NODE_OPTIONS="--import ..."
const RealDate = globalThis.Date;
const offsetStr = process.env.FAKE_CLOCK_OFFSET_MS;
const offset = offsetStr ? Number(offsetStr) : 0;

if (offset && !Number.isNaN(offset)) {
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(RealDate.now() + offset);
      } else {
        super(...args);
      }
    }

    static now() {
      return RealDate.now() + offset;
    }
  }

  Object.getOwnPropertyNames(RealDate).forEach((name) => {
    if (name !== "now" && name !== "prototype" && name !== "length" && name !== "name") {
      const desc = Object.getOwnPropertyDescriptor(RealDate, name);
      if (desc) Object.defineProperty(FakeDate, name, desc);
    }
  });

  globalThis.Date = FakeDate;
  process.stderr.write(`[fake-clock] offset=${offset} now=${new FakeDate().toISOString()}\n`);
}
