/* PAIR engine tests — 從 index.html 抽取引擎段並在 Node 執行 */
const fs = require("fs");
const vm = require("vm");

const html = fs.readFileSync(__dirname + "/index.html", "utf8");
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error("no script");
const marker = "\n/* ============================================================\n   UI";
const uiIdx = m[1].indexOf(marker);
if (uiIdx < 0) throw new Error("UI marker not found");
const engine = m[1].slice(0, uiIdx);

const sandbox = { module: { exports: {} }, exports: {} };
vm.createContext(sandbox);
vm.runInContext(engine, sandbox);
const E = sandbox.module.exports;

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name); }
}

function wrap(inner, rows, cols) {
  const b = Array.from({ length: rows + 2 }, (_, r) =>
    Array.from({ length: cols + 2 }, (_, c) => (r >= 1 && r <= rows && c >= 1 && c <= cols ? inner[r - 1][c - 1] : null)));
  return b;
}
// 手造棋盤：R×C 全格（含外圈），value = id 或 null
function grid(R, C, fn) {
  return Array.from({ length: R }, (_, r) => Array.from({ length: C }, (_, c) => fn(r, c)));
}

// 1. makeBoard 基本性質
for (const L of E.LEVELS) {
  const pairs = (L.rows * L.cols) / 2;
  const inner = E.makeBoard(L.rows, L.cols);
  const flat = inner.flat();
  ok(flat.length === pairs * 2, `L ${L.rows}x${L.cols} = ${pairs} 對, cells=${flat.length}`);
  const counts = {};
  flat.forEach((id) => (counts[id] = (counts[id] || 0) + 1));
  ok(Object.keys(counts).length === pairs && Object.values(counts).every((n) => n === 2), `L ${L.rows}x${L.cols} 每 id 恰好 2 枚`);
}

// 2. canConnect 手造情境（含外圈）
{
  // 直線 0 轉：A(1,1) B(1,3)，中間 (1,2) 空
  let b = grid(5, 5, () => null);
  b[1][1] = "A"; b[1][3] = "A";
  ok(E.canConnect(b, 1, 1, 1, 3) === 0, "直線 0 轉彎可連");
  // 中間被擋：可繞外圈（頂行空）→ 2 轉彎
  b[1][2] = "X";
  ok(E.canConnect(b, 1, 1, 1, 3) === 2, "直線被擋仍可繞外圈（2 轉彎）");
  // 中間與上下外圈全封死 → 真不可連
  b[0][1] = "X"; b[0][2] = "X"; b[0][3] = "X";
  b[4][1] = "X"; b[4][2] = "X"; b[4][3] = "X";
  b[2][0] = "X"; b[2][1] = "X"; b[2][2] = "X"; b[2][3] = "X";
  b[3][0] = "X"; b[3][4] = "X";
  ok(E.canConnect(b, 1, 1, 1, 3) === null, "全封死不可連");
  // L 形 1 轉：A(1,1) B(3,3)，路徑 (2,1)(3,1)(3,2) 空
  b = grid(5, 5, () => null);
  b[1][1] = "A"; b[3][3] = "A"; b[2][3] = "X"; b[1][2] = "X";
  const r1 = E.canConnect(b, 1, 1, 3, 3);
  ok(r1 === 1, `L 形 1 轉彎可連 (got ${r1})`);
  // Z 形 2 轉：A(2,2) B(2,4)，(2,3) 擋 → 上繞 (1,2)(1,3)(1,4)
  b = grid(5, 5, () => null);
  b[2][2] = "A"; b[2][4] = "A"; b[2][3] = "X"; b[3][2] = "X"; b[3][3] = "X";
  const r2 = E.canConnect(b, 2, 2, 2, 4);
  ok(r2 === 2, `Z 形 2 轉彎可連 (got ${r2})`);
  // 繞外圈：A(1,1) B(3,1)，(2,1) 擋 → 走左邊 border col0
  b = grid(5, 5, () => null);
  b[1][1] = "A"; b[3][1] = "A"; b[2][1] = "X";
  const r3 = E.canConnect(b, 1, 1, 3, 1);
  ok(r3 !== null, `繞外圈空槽可連 (got ${r3})`);
  // 不同 id 不可視為一對（canConnect 不管 id，只回路徑；這裡測任一端空）
  ok(E.canConnect(b, 0, 0, 1, 1) === null, "起點為空格不可連");
  // 兩端點相同
  ok(E.canConnect(b, 1, 1, 1, 1) === null, "同格不可連");
}

// 3. findMove / reshuffle 完整性（8 個等級 × 10 種子）
for (let seed = 0; seed < 10; seed++) {
  for (const L of E.LEVELS) {
    const inner = E.makeBoard(L.rows, L.cols);
    const b = wrap(inner, L.rows, L.cols);
    const flat = (bb) => bb.flat().filter((x) => x !== null).sort();
    const before = flat(b);
    let mv = E.findMove(b);
    if (mv) ok(E.canConnect(b, mv[0].r, mv[0].c, mv[1].r, mv[1].c) !== null, `findMove 回傳合法 (L${L.rows}x${L.cols} seed${seed})`);
    const rb = E.reshuffle(b);
    ok(JSON.stringify(flat(rb)) === JSON.stringify(before), `reshuffle 保留同 multiset (L${L.rows}x${L.cols} seed${seed})`);
  }
}

// 4. 整局自動遊玩（隨機 + 無解自動重排），各等級 × 3 種子須能清空
for (let seed = 0; seed < 3; seed++) {
  for (const L of E.LEVELS) {
    let inner = E.makeBoard(L.rows, L.cols);
    let b = wrap(inner, L.rows, L.cols);
    let rounds = 0, maxRounds = 4000, cleared = false;
    while (rounds++ < maxRounds) {
      const mv = E.findMove(b);
      if (mv) {
        b[mv[0].r][mv[0].c] = null; b[mv[1].r][mv[1].c] = null;
        if (b.flat().every((x) => x === null)) { cleared = true; break; }
      } else {
        let rb = b;
        for (let t = 0; t < 80; t++) {
          rb = E.reshuffle(rb);
          if (E.findMove(rb)) break;
        }
        b = rb;
        if (!E.findMove(b)) break; // 連 80 次重排仍無解 → 放棄此局
      }
    }
    ok(cleared, `整局可清空 (L${L.rows}x${L.cols} seed${seed}, rounds=${rounds})`);
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
