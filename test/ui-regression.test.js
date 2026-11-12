import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const stockModalSource = appSource.slice(
  appSource.indexOf("function openStockModal"),
  appSource.indexOf("function openItemModal"),
);

test("stock adjustment controls use whole-number steps", () => {
  assert.match(stockModalSource, /step="1"/);
  assert.doesNotMatch(stockModalSource, /step="0\.01"/);
});

test("a drag ending on the dialog backdrop does not dismiss the modal", () => {
  assert.doesNotMatch(appSource, /event\.target === modal[^\n]+modal\.close\(\)/);
  assert.match(appSource, /startedOnBackdrop/);
});
