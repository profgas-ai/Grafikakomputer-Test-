
// ============================================================
//  BAGIAN 1: KONFIGURASI GLOBAL
// ============================================================

const MAP_W  = 1400;   // Lebar peta dalam piksel (lebih besar dari viewport)
const MAP_H  = 1100;   // Tinggi peta dalam piksel

const ROAD_W = 18;     // Lebar jalan utama (piksel)
const CAR_SPEED = 120; // Kecepatan mobil piksel/detik

// Berapa banyak segmen jalan digenerate
const NUM_NODES      = 28;   // Jumlah node persimpangan
const NUM_EXTRA_CONN = 14;   // Koneksi tambahan agar graph lebih lebat

// Batasan zona — jalan tidak dibuat di tepi peta
const MARGIN = 80;

// ============================================================
//  BAGIAN 2: STATE APLIKASI
// ============================================================

// Graph jalan (vektor):
//   nodes[i] = { id, x, y }                    — titik persimpangan
//   edges[i] = { id, a, b, pts, length, type }  — segmen jalan
//     pts   = array titik [{x,y}] untuk animasi (disampling dari kurva)
//     type  = 'straight' | 'diagonal' | 'curve'
let nodes = [];
let edges = [];

// Adjacency list untuk pathfinding
//   adjList[nodeId] = [ {nodeId, edgeId, reversed}, ... ]
let adjList = {};

// Start & End node id
let startId = null;
let endId   = null;

// Path hasil Dijkstra: array { edgeId, reversed }
let pathEdges = [];
// Path titik-titik halus untuk animasi
let pathPoints = [];   // [{x,y}]

// State animasi
let animRunning  = false;
let animPaused   = false;
let animFrame    = null;
let carPtIndex   = 0;
let carX = 0, carY = 0;
let carAngle = 0;
let lastTime = 0;

// State peta
let mapReady = false;
let posReady = false;

// Kamera
let camOffX  = 0;
let camOffY  = 0;
let camScale = 1.0;
const SCALE_MIN  = 0.25;
const SCALE_MAX  = 4.0;
const SCALE_STEP = 0.2;

// Drag
let isDragging  = false;
let dragStartX  = 0;
let dragStartY  = 0;
let camOffXSnap = 0;
let camOffYSnap = 0;

// ============================================================
//  BAGIAN 3: REFERENSI DOM
// ============================================================

const bgCanvas    = document.getElementById('bgCanvas');
const bgCtx       = bgCanvas.getContext('2d');
const fgCanvas    = document.getElementById('fgCanvas');
const fgCtx       = fgCanvas.getContext('2d');
const roadSVG     = document.getElementById('roadSVG');
const wrapper     = document.getElementById('canvasWrapper');
const hint        = document.getElementById('canvasHint');
const btnStart    = document.getElementById('btnStartPause');
const btnLabel    = document.getElementById('btnLabel');
const iconPlay    = document.getElementById('iconPlay');
const iconPause   = document.getElementById('iconPause');
const zoomLabel   = document.getElementById('zoomLabel');
const infoStatus  = document.getElementById('infoStatus');
const infoPathLen = document.getElementById('infoPathLen');
const infoRoadSegs= document.getElementById('infoRoadSegs');
const infoProgress= document.getElementById('infoProgress');
const progressBar = document.getElementById('progressBar');

// ============================================================
//  BAGIAN 4: INISIALISASI LAYER
//  Tiga layer (bgCanvas, roadSVG, fgCanvas) pakai ukuran sama
// ============================================================

function initLayers() {
  [bgCanvas, fgCanvas].forEach(c => {
    c.width  = MAP_W;
    c.height = MAP_H;
  });
  roadSVG.setAttribute('width',  MAP_W);
  roadSVG.setAttribute('height', MAP_H);
  roadSVG.setAttribute('viewBox', `0 0 ${MAP_W} ${MAP_H}`);

  // Pusatkan kamera
  const ww = wrapper.clientWidth;
  const wh = wrapper.clientHeight;
  camOffX = (ww - MAP_W * camScale) / 2;
  camOffY = (wh - MAP_H * camScale) / 2;
  applyTransform();
}

function applyTransform() {
  const t = `translate(${camOffX}px, ${camOffY}px) scale(${camScale})`;
  bgCanvas.style.transform = t;
  roadSVG.style.transform  = t;
  fgCanvas.style.transform = t;
  zoomLabel.textContent = Math.round(camScale * 100) + '%';
}

// ============================================================
//  BAGIAN 5: GENERATE MAP — Graph Berbasis Vektor
//
//  Algoritma:
//  1. Scatter node-node persimpangan secara acak (dengan grid jitter
//     agar tidak terlalu menumpuk)
//  2. Bangun Minimum Spanning Tree (Prim) agar semua terhubung
//  3. Tambahkan koneksi extra untuk membuat loop dan variasi rute
//  4. Untuk setiap edge, tentukan tipe jalan:
//       - diagonal  : jika sudut ~45° (bukan 0°/90°)
//       - curve     : lengkung Bezier kubik dengan kontrol acak
//       - straight  : hanya sebagian kecil (<10%)
//  5. Sample titik-titik sepanjang kurva untuk pathfinding & animasi
// ============================================================

function generateMap() {
  stopAnimation();
  mapReady = false;
  posReady = false;
  startId  = null;
  endId    = null;
  pathEdges  = [];
  pathPoints = [];

  // --- 5a. Generate nodes (grid jitter) ---
  nodes = [];
  const GCOLS = 7, GROWS = 5;
  const cellW = (MAP_W - MARGIN * 2) / GCOLS;
  const cellH = (MAP_H - MARGIN * 2) / GROWS;

  for (let gr = 0; gr < GROWS; gr++) {
    for (let gc = 0; gc < GCOLS; gc++) {
      // Jitter dalam cell agar posisi tidak seragam
      const jx = (Math.random() * 0.7 + 0.15) * cellW;
      const jy = (Math.random() * 0.7 + 0.15) * cellH;
      nodes.push({
        id: nodes.length,
        x: MARGIN + gc * cellW + jx,
        y: MARGIN + gr * cellH + jy
      });
    }
  }

  // Tambah beberapa node ekstra acak di area tengah
  for (let i = 0; i < 8; i++) {
    nodes.push({
      id: nodes.length,
      x: MARGIN + Math.random() * (MAP_W - MARGIN * 2),
      y: MARGIN + Math.random() * (MAP_H - MARGIN * 2)
    });
  }

  // --- 5b. Minimum Spanning Tree (Prim) agar semua node terhubung ---
  edges = [];
  adjList = {};
  nodes.forEach(n => adjList[n.id] = []);

  const inMST = new Set([0]);
  while (inMST.size < nodes.length) {
    let bestDist = Infinity, bestA = -1, bestB = -1;
    for (const a of inMST) {
      for (let b = 0; b < nodes.length; b++) {
        if (inMST.has(b)) continue;
        const d = dist(nodes[a], nodes[b]);
        if (d < bestDist) { bestDist = d; bestA = a; bestB = b; }
      }
    }
    addEdge(bestA, bestB);
    inMST.add(bestB);
  }

  // --- 5c. Tambah koneksi extra (loop & variasi rute) ---
  //  Pilih pasangan node yang belum terhubung langsung & jaraknya wajar
  const maxExtraDist = Math.max(MAP_W, MAP_H) * 0.42;
  let extraCount = 0;
  const shuffled = [...nodes].sort(() => Math.random() - 0.5);
  for (let i = 0; i < shuffled.length && extraCount < NUM_EXTRA_CONN; i++) {
    for (let j = i + 1; j < shuffled.length && extraCount < NUM_EXTRA_CONN; j++) {
      const a = shuffled[i].id, b = shuffled[j].id;
      if (isDirectlyConnected(a, b)) continue;
      const d = dist(nodes[a], nodes[b]);
      if (d < maxExtraDist && Math.random() < 0.55) {
        addEdge(a, b);
        extraCount++;
      }
    }
  }

  // --- 5d. Hitung statistik jalan ---
  const types = edges.map(e => e.type);
  const nStraight = types.filter(t => t === 'straight').length;
  const pct = Math.round((nStraight / edges.length) * 100);
  infoRoadSegs.textContent = `${edges.length} (${pct}% lurus)`;

  // --- 5e. Render semua layer ---
  drawBackground();
  drawRoadsSVG();
  drawForeground();

  mapReady = true;
  hint.classList.add('hidden');
  setStatus('Map Ready', 'status-ready');
  updateUI();
}

// -------- Helper: tambah edge antara node a dan b --------
function addEdge(aId, bId) {
  const na = nodes[aId], nb = nodes[bId];
  const edgeId = edges.length;

  // Tentukan tipe jalan berdasarkan sudut
  const dx = nb.x - na.x;
  const dy = nb.y - na.y;
  const angle = Math.abs(Math.atan2(dy, dx) * 180 / Math.PI);
  // angle ~0 atau ~180 = horizontal, ~90 = vertikal → straight
  // angle ~45 atau ~135 → diagonal
  const isHV = (angle < 18 || angle > 162 || (angle > 72 && angle < 108));

  let type;
  const r = Math.random();
  if (isHV && r < 0.15) {
    // Hanya 15% dari jalan H/V yang benar-benar lurus
    type = 'straight';
  } else if (!isHV && r < 0.35) {
    // Jalan diagonal (tidak diberi lengkung, sudut alami)
    type = 'diagonal';
  } else {
    // Mayoritas: lengkung Bezier
    type = 'curve';
  }

  // Buat titik kontrol kurva Bezier (untuk tipe 'curve')
  let cp1 = null, cp2 = null;
  if (type === 'curve') {
    // Kontrol acak: geser tegak lurus dari midpoint
    const mx = (na.x + nb.x) / 2;
    const my = (na.y + nb.y) / 2;
    const len = dist(na, nb);
    // Vektor tegak lurus
    const nx_ = -dy / len, ny_ = dx / len;
    const bend = (Math.random() * 0.35 + 0.1) * len * (Math.random() < 0.5 ? 1 : -1);
    // Dua kontrol point terpisah agar lebih organik
    const split = 0.3 + Math.random() * 0.4;
    cp1 = {
      x: na.x + (mx - na.x) * split * 2 + nx_ * bend * 0.6,
      y: na.y + (my - na.y) * split * 2 + ny_ * bend * 0.6
    };
    cp2 = {
      x: nb.x - (nb.x - mx) * (1 - split) * 2 + nx_ * bend * 0.9,
      y: nb.y - (nb.y - my) * (1 - split) * 2 + ny_ * bend * 0.9
    };
  }

  // Sample titik sepanjang kurva untuk animasi & panjang
  const pts = sampleCurve(na, nb, cp1, cp2, type);
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += dist(pts[i-1], pts[i]);

  const edge = { id: edgeId, a: aId, b: bId, cp1, cp2, pts, length, type };
  edges.push(edge);

  // Update adjacency list (dua arah)
  adjList[aId].push({ nodeId: bId, edgeId, reversed: false });
  adjList[bId].push({ nodeId: aId, edgeId, reversed: true });
}

// -------- Helper: cek apakah dua node sudah langsung terhubung --------
function isDirectlyConnected(a, b) {
  return adjList[a] && adjList[a].some(e => e.nodeId === b);
}

// -------- Sample titik sepanjang kurva --------
//  Menghasilkan array {x,y} dengan jarak antar titik ~5px
function sampleCurve(na, nb, cp1, cp2, type) {
  const pts = [];
  const STEPS = 60;
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS;
    let x, y;
    if (type === 'curve' && cp1 && cp2) {
      // Bezier kubik
      const mt = 1 - t;
      x = mt*mt*mt*na.x + 3*mt*mt*t*cp1.x + 3*mt*t*t*cp2.x + t*t*t*nb.x;
      y = mt*mt*mt*na.y + 3*mt*mt*t*cp1.y + 3*mt*t*t*cp2.y + t*t*t*nb.y;
    } else {
      // Linear (straight / diagonal)
      x = na.x + t * (nb.x - na.x);
      y = na.y + t * (nb.y - na.y);
    }
    pts.push({ x, y });
  }
  return pts;
}

// -------- Euclidean distance --------
function dist(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  return Math.sqrt(dx*dx + dy*dy);
}

// ============================================================
//  BAGIAN 6: RENDER LAYER BG — Latar (terrain + gedung + taman)
//
//  Latar digambar dengan Canvas 2D biasa. Karena hanya berisi
//  blok warna / texture statis tanpa garis tipis, pixelation
//  pada zoom tinggi tidak terlihat mengganggu.
// ============================================================

function drawBackground() {
  const ctx = bgCtx;
  ctx.clearRect(0, 0, MAP_W, MAP_H);

  // Base: tanah / lapangan
  ctx.fillStyle = '#1a2e1a';
  ctx.fillRect(0, 0, MAP_W, MAP_H);

  // Grid checkerboard rumput halus
  const gs = 50;
  for (let gy = 0; gy < MAP_H; gy += gs) {
    for (let gx = 0; gx < MAP_W; gx += gs) {
      const even = ((gx / gs + gy / gs) % 2 === 0);
      ctx.fillStyle = even ? '#1e3520' : '#1a3018';
      ctx.fillRect(gx, gy, gs, gs);
    }
  }

  // Blok taman (patch hijau lebih terang)
  const rng = seededRand(42);
  for (let i = 0; i < 22; i++) {
    const px = rng() * (MAP_W - 120) + 40;
    const py = rng() * (MAP_H - 100) + 40;
    const pw = 60 + rng() * 80;
    const ph = 50 + rng() * 70;
    ctx.fillStyle = `rgba(56,161,105,${0.18 + rng() * 0.12})`;
    ctx.beginPath();
    ctx.ellipse(px + pw/2, py + ph/2, pw/2, ph/2, rng() * Math.PI, 0, Math.PI*2);
    ctx.fill();
  }

  // Gedung-gedung (blok persegi panjang acak di area non-jalan)
  const rng2 = seededRand(99);
  for (let i = 0; i < 55; i++) {
    const bx = rng2() * (MAP_W - 160) + 60;
    const by = rng2() * (MAP_H - 140) + 60;
    const bw = 28 + rng2() * 52;
    const bh = 24 + rng2() * 48;

    // Cek jarak ke semua edge — jangan render gedung di atas jalan
    if (isTooCloseToRoads(bx + bw/2, by + bh/2, Math.max(bw,bh)/2 + ROAD_W)) continue;

    // Tembok gedung
    const hue = 220 + rng2() * 60;
    ctx.fillStyle = `hsl(${hue},25%,22%)`;
    ctx.fillRect(bx, by, bw, bh);

    // Atap
    ctx.fillStyle = `hsl(${hue},30%,30%)`;
    const rm = 4;
    ctx.fillRect(bx+rm, by+rm, bw-rm*2, bh-rm*2);

    // Jendela kecil
    ctx.fillStyle = `rgba(160,200,255,0.55)`;
    const wSize = 5;
    for (let wy = by+8; wy < by+bh-8; wy += 10) {
      for (let wx = bx+8; wx < bx+bw-8; wx += 10) {
        if (rng2() > 0.4) ctx.fillRect(wx, wy, wSize, wSize);
      }
    }

    // Tepi gedung
    ctx.strokeStyle = `hsl(${hue},20%,40%)`;
    ctx.lineWidth = 1;
    ctx.strokeRect(bx, by, bw, bh);
  }

  // Pohon-pohon di area taman
  const rng3 = seededRand(77);
  for (let i = 0; i < 90; i++) {
    const tx = rng3() * MAP_W;
    const ty = rng3() * MAP_H;
    if (isTooCloseToRoads(tx, ty, ROAD_W + 8)) continue;
    drawTree(ctx, tx, ty, 5 + rng3() * 5);
  }
}

// -------- Cek apakah titik terlalu dekat ke jalan mana pun --------
function isTooCloseToRoads(px, py, minDist) {
  for (const e of edges) {
    const step = Math.max(1, Math.floor(e.pts.length / 8));
    for (let i = 0; i < e.pts.length; i += step) {
      if (dist({x:px,y:py}, e.pts[i]) < minDist) return true;
    }
  }
  return false;
}

// -------- Gambar pohon pixel-style --------
function drawTree(ctx, px, py, size) {
  const s = size;
  ctx.fillStyle = '#5a3a1a';
  ctx.fillRect(px - s*0.3, py + s*0.4, s*0.6, s*0.9);
  ctx.fillStyle = '#1a4a1a';
  ctx.fillRect(px - s, py + s*0.1, s*2, s*0.8);
  ctx.fillStyle = '#2d7a2d';
  ctx.fillRect(px - s*0.8, py - s*0.3, s*1.6, s*0.8);
  ctx.fillStyle = '#3fa03f';
  ctx.fillRect(px - s*0.5, py - s*0.9, s, s*0.8);
}

// ============================================================
//  BAGIAN 7: RENDER LAYER SVG ROADS — Jalan Vektor
//
//  SVG digunakan agar jalan SELALU TAJAM pada semua level zoom.
//  Setiap edge digambar sebagai <path> dengan:
//   - Bayangan aspal (lebar lebih besar, warna gelap)
//   - Aspal utama
//   - Garis tengah putus-putus
// ============================================================

function drawRoadsSVG() {
  // Hapus semua child lama
  while (roadSVG.firstChild) roadSVG.removeChild(roadSVG.firstChild);

  // Buat group layer
  const gShadow = svgEl('g'); // Bayangan/tepi jalan
  const gAspal  = svgEl('g'); // Aspal utama
  const gLines  = svgEl('g'); // Garis tengah
  const gNodes  = svgEl('g'); // Titik persimpangan
  roadSVG.appendChild(gShadow);
  roadSVG.appendChild(gAspal);
  roadSVG.appendChild(gLines);
  roadSVG.appendChild(gNodes);

  for (const e of edges) {
    const d = edgeToSVGPath(e);

    // Bayangan (lebih lebar)
    const shadow = svgEl('path');
    shadow.setAttribute('d', d);
    shadow.setAttribute('fill', 'none');
    shadow.setAttribute('stroke', '#0a0c10');
    shadow.setAttribute('stroke-width', ROAD_W + 8);
    shadow.setAttribute('stroke-linecap', 'round');
    shadow.setAttribute('stroke-linejoin', 'round');
    gShadow.appendChild(shadow);

    // Aspal utama
    const road = svgEl('path');
    road.setAttribute('d', d);
    road.setAttribute('fill', 'none');
    road.setAttribute('stroke', '#2d3340');
    road.setAttribute('stroke-width', ROAD_W);
    road.setAttribute('stroke-linecap', 'round');
    road.setAttribute('stroke-linejoin', 'round');
    gAspal.appendChild(road);

    // Tepi jalan (trotoar)
    const curb = svgEl('path');
    curb.setAttribute('d', d);
    curb.setAttribute('fill', 'none');
    curb.setAttribute('stroke', '#3d4455');
    curb.setAttribute('stroke-width', ROAD_W - 2);
    curb.setAttribute('stroke-linecap', 'round');
    curb.setAttribute('stroke-dasharray', '1 0');
    curb.setAttribute('opacity', '0.4');
    gAspal.appendChild(curb);

    // Garis tengah putus-putus
    const center = svgEl('path');
    center.setAttribute('d', d);
    center.setAttribute('fill', 'none');
    center.setAttribute('stroke', '#e8c840');
    center.setAttribute('stroke-width', 1.5);
    center.setAttribute('stroke-dasharray', '12 8');
    center.setAttribute('stroke-linecap', 'butt');
    center.setAttribute('opacity', '0.7');
    gLines.appendChild(center);
  }

  // Persimpangan (lingkaran kecil di tiap node)
  for (const n of nodes) {
    const c = svgEl('circle');
    c.setAttribute('cx', n.x);
    c.setAttribute('cy', n.y);
    c.setAttribute('r', ROAD_W / 2 + 1);
    c.setAttribute('fill', '#2d3340');
    c.setAttribute('stroke', '#0a0c10');
    c.setAttribute('stroke-width', 3);
    gNodes.appendChild(c);
  }
}

// -------- Konversi edge ke SVG path string --------
function edgeToSVGPath(e) {
  const na = nodes[e.a], nb = nodes[e.b];
  if (e.type === 'curve' && e.cp1 && e.cp2) {
    return `M ${na.x} ${na.y} C ${e.cp1.x} ${e.cp1.y} ${e.cp2.x} ${e.cp2.y} ${nb.x} ${nb.y}`;
  } else {
    return `M ${na.x} ${na.y} L ${nb.x} ${nb.y}`;
  }
}

// -------- Helper: buat elemen SVG --------
function svgEl(tag) {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

// ============================================================
//  BAGIAN 8: RENDER LAYER FG — Foreground (path, mobil, marker)
//
//  Layer ini di-redraw setiap frame animasi.
//  Juga menggambar path BFS & marker start/end.
// ============================================================

function drawForeground() {
  const ctx = fgCtx;
  ctx.clearRect(0, 0, MAP_W, MAP_H);

  // Gambar path BFS (garis cyan transparan)
  if (pathPoints.length > 1) {
    ctx.beginPath();
    ctx.moveTo(pathPoints[0].x, pathPoints[0].y);
    for (let i = 1; i < pathPoints.length; i++) {
      ctx.lineTo(pathPoints[i].x, pathPoints[i].y);
    }
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.4)';
    ctx.lineWidth = 5;
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  // Gambar marker start
  if (startId !== null) {
    const n = nodes[startId];
    drawMarker(ctx, n.x, n.y, '#e74c3c', 'S');
  }

  // Gambar marker end
  if (endId !== null) {
    const n = nodes[endId];
    drawMarker(ctx, n.x, n.y, '#f39c12', 'E');
  }

  // Gambar mobil
  if (posReady) {
    drawCar(ctx, carX, carY, carAngle);
  }
}

// -------- Marker berbentuk pin (S/E) --------
function drawMarker(ctx, x, y, color, label) {
  const R = 14;
  // Lingkaran
  ctx.beginPath();
  ctx.arc(x, y, R, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  // Border putih
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  // Label
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 12px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x, y);
}

// -------- Gambar mobil top-view --------
//  Mobil dirender dengan ctx.save/rotate/restore agar rotasi
//  tidak mempengaruhi elemen lain. Sudut dari Math.atan2(dy,dx).
function drawCar(ctx, cx, cy, angle) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);

  const W = 12, H = 22;  // Lebar & panjang mobil

  // Bayangan mobil
  ctx.shadowColor = 'rgba(0,0,0,0.5)';
  ctx.shadowBlur  = 8;
  ctx.shadowOffsetY = 3;

  // Badan utama
  ctx.fillStyle = '#cc2222';
  roundRectPath(ctx, -W/2, -H/2, W, H, 3);
  ctx.fill();

  ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

  // Garis tepi badan
  ctx.strokeStyle = '#880000';
  ctx.lineWidth = 1;
  roundRectPath(ctx, -W/2, -H/2, W, H, 3);
  ctx.stroke();

  // Atap
  ctx.fillStyle = '#aa1111';
  roundRectPath(ctx, -W*0.35, -H*0.28, W*0.7, H*0.42, 2);
  ctx.fill();

  // Kaca depan
  ctx.fillStyle = 'rgba(136,204,255,0.85)';
  roundRectPath(ctx, -W*0.28, -H*0.25, W*0.56, H*0.18, 2);
  ctx.fill();

  // Kaca belakang
  roundRectPath(ctx, -W*0.28, H*0.08, W*0.56, H*0.16, 2);
  ctx.fill();

  // Lampu depan
  ctx.fillStyle = '#ffffaa';
  ctx.fillRect(-W/2+2, -H/2+2, W*0.22, H*0.09);
  ctx.fillRect( W/2-W*0.22-2, -H/2+2, W*0.22, H*0.09);

  // Roda (4 buah)
  ctx.fillStyle = '#111';
  const wx = W/2 - 1, wy = H/2 - 4;
  ctx.fillRect(-wx-3, -wy,    3, 7);  // Kiri depan
  ctx.fillRect( wx,   -wy,    3, 7);  // Kanan depan
  ctx.fillRect(-wx-3,  wy-7,  3, 7);  // Kiri belakang
  ctx.fillRect( wx,    wy-7,  3, 7);  // Kanan belakang

  ctx.restore();
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x+w, y,   x+w, y+r);
  ctx.lineTo(x+w, y+h-r);
  ctx.quadraticCurveTo(x+w, y+h, x+w-r, y+h);
  ctx.lineTo(x+r, y+h);
  ctx.quadraticCurveTo(x,   y+h, x, y+h-r);
  ctx.lineTo(x, y+r);
  ctx.quadraticCurveTo(x,   y,   x+r, y);
  ctx.closePath();
}

// ============================================================
//  BAGIAN 9: RANDOM POSITION
//  Pilih start & end node secara acak, cari jalur Dijkstra
// ============================================================

function randomPosition() {
  if (!mapReady || nodes.length < 2) return;
  stopAnimation();

  let tries = 0, found = false;
  while (tries < 80 && !found) {
    const a = Math.floor(Math.random() * nodes.length);
    let b   = Math.floor(Math.random() * nodes.length);
    while (b === a) b = Math.floor(Math.random() * nodes.length);

    const result = dijkstra(a, b);
    if (result && result.edgePath.length >= 1) {
      startId    = a;
      endId      = b;
      pathEdges  = result.edgePath;    // [{edgeId, reversed}]
      pathPoints = buildPathPoints(result.edgePath);

      // Set posisi awal mobil
      carX     = nodes[startId].x;
      carY     = nodes[startId].y;
      carPtIndex = 0;
      carAngle = 0;
      animPaused  = false;
      animRunning = false;
      posReady = true;
      found = true;
    }
    tries++;
  }

  if (!found) {
    setStatus('No path found', 'status-idle');
    return;
  }

  infoPathLen.textContent = pathPoints.length + ' pts';
  updateProgressBar(0);
  infoProgress.textContent = '0%';
  setStatus('Ready', 'status-ready');
  updateUI();
  drawForeground();
}

// ============================================================
//  BAGIAN 10: DIJKSTRA PATHFINDING
//
//  Karena peta berbasis graph vektor (bukan tile grid), kita
//  pakai Dijkstra yang mempertimbangkan panjang jalan nyata.
//
//  Cara Kerja:
//  1. Inisialisasi dist[semua] = Infinity, dist[start] = 0
//  2. Masukkan start ke priority queue (min-heap sederhana)
//  3. Ambil node dengan dist terkecil
//  4. Eksplorasi semua tetangga via adjList
//  5. Jika dist[tetangga] bisa diperkecil, update & masukkan queue
//  6. Rekonstruksi jalur via parentMap saat end ditemukan
// ============================================================

function dijkstra(startNodeId, endNodeId) {
  const distMap    = {};
  const parentMap  = {};  // parentMap[nodeId] = { fromNodeId, edgeId, reversed }
  const visited    = new Set();

  nodes.forEach(n => distMap[n.id] = Infinity);
  distMap[startNodeId] = 0;

  // Priority queue sederhana (array + sort)
  // Untuk graph kecil ini sudah cukup efisien
  const pq = [{ nodeId: startNodeId, d: 0 }];

  while (pq.length > 0) {
    // Ambil node dengan jarak terkecil
    pq.sort((a, b) => a.d - b.d);
    const { nodeId: cur } = pq.shift();

    if (visited.has(cur)) continue;
    visited.add(cur);

    if (cur === endNodeId) break;

    for (const { nodeId: next, edgeId, reversed } of (adjList[cur] || [])) {
      if (visited.has(next)) continue;
      const edgeLen = edges[edgeId].length;
      const newDist = distMap[cur] + edgeLen;
      if (newDist < distMap[next]) {
        distMap[next] = newDist;
        parentMap[next] = { fromNodeId: cur, edgeId, reversed };
        pq.push({ nodeId: next, d: newDist });
      }
    }
  }

  if (distMap[endNodeId] === Infinity) return null;

  // Rekonstruksi jalur edge dari end → start, lalu balik
  const edgePath = [];
  let cur = endNodeId;
  while (cur !== startNodeId) {
    const p = parentMap[cur];
    if (!p) return null;
    edgePath.push({ edgeId: p.edgeId, reversed: p.reversed });
    cur = p.fromNodeId;
  }
  edgePath.reverse();
  return { edgePath, totalDist: distMap[endNodeId] };
}

// -------- Bangun array titik halus dari array edge path --------
function buildPathPoints(edgePath) {
  const pts = [];
  for (const { edgeId, reversed } of edgePath) {
    const e = edges[edgeId];
    const segPts = reversed ? [...e.pts].reverse() : e.pts;
    // Hindari duplikat titik di persimpangan
    const start = pts.length > 0 ? 1 : 0;
    for (let i = start; i < segPts.length; i++) {
      pts.push(segPts[i]);
    }
  }
  return pts;
}

// ============================================================
//  BAGIAN 11: ANIMASI MOBIL
//
//  Animasi berbasis titik-titik halus (pathPoints) bukan tile.
//  Mobil meluncur dari satu titik ke titik berikutnya dengan
//  interpolasi berbasis delta time, sehingga kecepatan konstan
//  tanpa tergantung frame rate.
//
//  Sudut rotasi dihitung dari Math.atan2(dy, dx) — mobil selalu
//  menghadap arah jalur (tidak drift).
// ============================================================

function startAnimation() {
  if (!posReady || pathPoints.length < 2) return;

  if (animPaused) {
    animPaused  = false;
    animRunning = true;
    lastTime = performance.now();
    animFrame = requestAnimationFrame(animLoop);
  } else {
    carPtIndex  = 0;
    carX = pathPoints[0].x;
    carY = pathPoints[0].y;
    animRunning = true;
    animPaused  = false;
    lastTime = performance.now();
    animFrame = requestAnimationFrame(animLoop);
  }
  updateUI();
}

function pauseAnimation() {
  animRunning = false;
  animPaused  = true;
  if (animFrame) cancelAnimationFrame(animFrame);
  setStatus('Paused', 'status-paused');
  updateUI();
}

function stopAnimation() {
  animRunning = false;
  animPaused  = false;
  if (animFrame) cancelAnimationFrame(animFrame);
  animFrame = null;
}

function animLoop(timestamp) {
  if (!animRunning) return;

  const dt = Math.min((timestamp - lastTime) / 1000, 0.05); // Cap dt agar tidak lompat
  lastTime = timestamp;

  // Jika sudah sampai akhir path
  if (carPtIndex >= pathPoints.length - 1) {
    carX = pathPoints[pathPoints.length - 1].x;
    carY = pathPoints[pathPoints.length - 1].y;
    animRunning = false;
    setStatus('Arrived!', 'status-done');
    updateProgressBar(100);
    infoProgress.textContent = '100%';
    drawForeground();
    updateUI();
    return;
  }

  // Gerakkan mobil: konsumsi "jarak" sebesar CAR_SPEED * dt
  let remaining = CAR_SPEED * dt;

  while (remaining > 0 && carPtIndex < pathPoints.length - 1) {
    const target = pathPoints[carPtIndex + 1];
    const dx = target.x - carX;
    const dy = target.y - carY;
    const d  = Math.sqrt(dx*dx + dy*dy);

    if (d < 0.001) { carPtIndex++; continue; }

    // Update sudut (arah hadap mobil)
    carAngle = Math.atan2(dy, dx);

    if (remaining >= d) {
      // Lompat ke titik berikutnya
      carX = target.x;
      carY = target.y;
      carPtIndex++;
      remaining -= d;
    } else {
      // Gerak sebagian menuju titik berikutnya
      carX += (dx / d) * remaining;
      carY += (dy / d) * remaining;
      remaining = 0;
    }
  }

  // Update progress bar
  const prog = Math.round((carPtIndex / (pathPoints.length - 1)) * 100);
  infoProgress.textContent = prog + '%';
  updateProgressBar(prog);

  drawForeground();
  animFrame = requestAnimationFrame(animLoop);
}

// ============================================================
//  BAGIAN 12: UI UPDATE
// ============================================================

function updateUI() {
  if (!posReady) {
    btnStart.disabled = true;
    btnLabel.textContent = 'Start';
    iconPlay.style.display  = 'block';
    iconPause.style.display = 'none';
    btnStart.classList.remove('paused');
  } else if (animRunning) {
    btnStart.disabled = false;
    btnLabel.textContent = 'Pause';
    iconPlay.style.display  = 'none';
    iconPause.style.display = 'block';
    btnStart.classList.add('paused');
  } else {
    btnStart.disabled = false;
    btnLabel.textContent = animPaused ? 'Resume' : 'Start';
    iconPlay.style.display  = 'block';
    iconPause.style.display = 'none';
    btnStart.classList.remove('paused');
  }
}

function setStatus(text, cls) {
  infoStatus.textContent = text;
  infoStatus.className   = 'info-value ' + cls;
}

function updateProgressBar(pct) {
  progressBar.style.width = pct + '%';
}

// ============================================================
//  BAGIAN 13: ZOOM & PAN
//
//  Zoom dilakukan dengan mengubah CSS transform pada semua
//  tiga layer secara bersamaan. Pivot dihitung agar posisi
//  di bawah kursor/tengah layar tidak bergeser.
// ============================================================

function zoomAt(pivotX, pivotY, delta) {
  const newScale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, camScale + delta));
  if (newScale === camScale) return;
  const factor = newScale / camScale;
  camOffX = pivotX - factor * (pivotX - camOffX);
  camOffY = pivotY - factor * (pivotY - camOffY);
  camScale = newScale;
  applyTransform();
}

// ============================================================
//  BAGIAN 14: EVENT LISTENERS
// ============================================================

document.getElementById('btnRandomMap').addEventListener('click', () => {
  generateMap();
});

document.getElementById('btnRandomPos').addEventListener('click', () => {
  if (!mapReady) { alert('Generate map dulu!'); return; }
  randomPosition();
});

btnStart.addEventListener('click', () => {
  if (animRunning) {
    pauseAnimation();
  } else {
    startAnimation();
    setStatus('Running', 'status-running');
  }
});

document.getElementById('btnReset').addEventListener('click', () => {
  stopAnimation();
  if (posReady && pathPoints.length > 0) {
    carPtIndex  = 0;
    carX = pathPoints[0].x;
    carY = pathPoints[0].y;
    carAngle = 0;
    animPaused = false;
    updateProgressBar(0);
    infoProgress.textContent = '0%';
    setStatus('Ready', 'status-ready');
    updateUI();
    drawForeground();
  }
});

document.getElementById('btnZoomIn').addEventListener('click', () => {
  zoomAt(wrapper.clientWidth/2, wrapper.clientHeight/2,  SCALE_STEP);
});

document.getElementById('btnZoomOut').addEventListener('click', () => {
  zoomAt(wrapper.clientWidth/2, wrapper.clientHeight/2, -SCALE_STEP);
});

// Scroll wheel zoom
wrapper.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP;
  const rect  = wrapper.getBoundingClientRect();
  zoomAt(e.clientX - rect.left, e.clientY - rect.top, delta);
}, { passive: false });

// Mouse drag (pan)
wrapper.addEventListener('mousedown', (e) => {
  isDragging  = true;
  dragStartX  = e.clientX;
  dragStartY  = e.clientY;
  camOffXSnap = camOffX;
  camOffYSnap = camOffY;
});
window.addEventListener('mousemove', (e) => {
  if (!isDragging) return;
  camOffX = camOffXSnap + (e.clientX - dragStartX);
  camOffY = camOffYSnap + (e.clientY - dragStartY);
  applyTransform();
});
window.addEventListener('mouseup', () => { isDragging = false; });

// Touch drag (mobile pan)
wrapper.addEventListener('touchstart', (e) => {
  if (e.touches.length === 1) {
    isDragging  = true;
    dragStartX  = e.touches[0].clientX;
    dragStartY  = e.touches[0].clientY;
    camOffXSnap = camOffX;
    camOffYSnap = camOffY;
  }
}, { passive: true });
wrapper.addEventListener('touchmove', (e) => {
  if (!isDragging || e.touches.length !== 1) return;
  camOffX = camOffXSnap + (e.touches[0].clientX - dragStartX);
  camOffY = camOffYSnap + (e.touches[0].clientY - dragStartY);
  applyTransform();
}, { passive: true });
wrapper.addEventListener('touchend', () => { isDragging = false; });

// Resize: pusatkan ulang kamera
window.addEventListener('resize', () => {
  const ww = wrapper.clientWidth;
  const wh = wrapper.clientHeight;
  camOffX = (ww - MAP_W * camScale) / 2;
  camOffY = (wh - MAP_H * camScale) / 2;
  applyTransform();
});

// ============================================================
//  BAGIAN 15: UTILITY — Seeded Random Number Generator
//
//  Digunakan agar background (gedung, pohon) konsisten
//  setiap render tanpa perlu disimpan.
// ============================================================

function seededRand(seed) {
  let s = seed;
  return function() {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

// ============================================================
//  BAGIAN 16: INISIALISASI AWAL
// ============================================================

window.addEventListener('load', () => {
  initLayers();
  hint.classList.remove('hidden');
});

