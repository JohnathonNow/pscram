/**
 * Public entrypoint for the Minilang UI Runtime (`MinijsUI`, `MinijsVM`)
 * and Shared Visualization Engine (`MlnbViz`).
 */

import { MlnbViz, parseCsv, normalizeTablePayload, mountTable, mountChart } from "../viz/viz.js";
import { MinijsUI, MinijsVM } from "./vm.js";

if (typeof window !== "undefined") {
  window.MlnbViz = MlnbViz;
  window.MinijsUI = MinijsUI;
}

export {
  MinijsUI,
  MinijsVM,
  MlnbViz,
  parseCsv,
  normalizeTablePayload,
  mountTable,
  mountChart,
};
