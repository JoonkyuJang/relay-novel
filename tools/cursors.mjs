// Pixel cursors for css/extras.css (body.fx-cursor). Run: node tools/cursors.mjs, paste the output.
// Cells: # ink · w cream fill; a cream halo is added around the ink so they show on the night sky too.
const S = 1.5;   // css px per cell (3 device pixels on retina screens)
const INK = '#1D2A44', CREAM = '#FFF9EF';
const C = {
  arrow: { hot: [0, 0], rows: [
    '#.........', '##........', '#w#.......', '#ww#......', '#www#.....', '#wwww#....', '#wwwww#...', '#wwwwww#..',
    '#wwwwwww#.', '#wwwwwwww#', '#wwww#####', '#ww#w#....', '#w#.#w#...', '##..#w#...', '#....#w#..', '.....#w#..', '......#...'] },
  hand: { hot: [5, 0], rows: [
    '.....##.........', '....#ww#........', '....#ww#........', '....#ww#........', '....#ww###......', '....#ww#ww###...',
    '....#ww#ww#ww##.', '.##.#ww#ww#ww#w#', '#ww##wwwwwwwwwww#', '#www#wwwwwwwwwww#', '.#wwwwwwwwwwwwww#', '..#wwwwwwwwwwwww#',
    '..#wwwwwwwwwwww#.', '...#wwwwwwwwwww#.', '....#wwwwwwwww#..', '.....#########...'] },
  text: { hot: [2, 8], rows: [
    '##.##', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..', '##.##'] },
  wait: { hot: [5, 5], rows: [
    '###########', '.#wwwwwww#.', '.#w#####w#.', '..#w###w#..', '...#w#w#...', '....#w#....', '...#w#w#...', '..#ww#ww#..', '.#ww###ww#.', '.#w#####w#.', '###########'] },
};
for (const [name, { hot, rows }] of Object.entries(C)) {
  let w = Math.max(...rows.map(r => r.length)) + 2, hgt = rows.length + 2;
  w += w % 2; hgt += hgt % 2;                       // whole css pixels at 1.5 × (cursor images must be)
  const grid = Array.from({ length: hgt }, (_, y) => Array.from({ length: w }, (_, x) => rows[y - 1]?.[x - 1] ?? '.'));
  // fill: anything enclosed (not reachable from the border through '.') that is '.' stays clear; halo around '#'
  const halo = grid.map((r, y) => r.map((c, x) => {
    if (c !== '.') return c;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (grid[y + dy]?.[x + dx] === '#') return 'h';
    return '.';
  }));
  const path = (ch) => halo.flatMap((r, y) => r.map((c, x) => (c === ch ? `M${x} ${y}h1v1h-1z` : ''))).join('');
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w * S}' height='${hgt * S}' viewBox='0 0 ${w} ${hgt}' shape-rendering='crispEdges'>`
    + `<path fill='${CREAM}' d='${path('h')}${path('w')}'/><path fill='${INK}' d='${path('#')}'/></svg>`;
  const uri = `data:image/svg+xml,${svg.replace(/#/g, '%23').replace(/</g, '%3C').replace(/>/g, '%3E')}`;
  console.log(`  --cur-${name}: url("${uri}") ${Math.floor((hot[0] + 1.5) * S)} ${Math.floor((hot[1] + 1.5) * S)};`);
}
