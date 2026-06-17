// Arcade FX — a tiny canvas particle engine shared by the Arcade player screen
// and the big-screen Cast view. Confetti bursts on a correct answer, confetti
// rain on a win. Cheap: one rAF loop that idles (no work) when there are no live
// particles, so it costs nothing between celebrations.
//
//   const fx = createParticleEngine(canvasEl);
//   fx.burst(x, y);   // a directional pop at a point (device px)
//   fx.rain();        // a screenful of falling confetti
//   fx.resize();      // call on layout/resize
//   fx.destroy();     // stop the loop + drop listeners

const COLORS = ['#fb5530', '#5b86ff', '#2ee6c8', '#ffd23d', '#ff3d8b', '#ffffff'];

export function createParticleEngine(canvas) {
  const ctx = canvas.getContext('2d');
  let particles = [];
  let raf = null;
  let dpr = 1;
  let w = 0;
  let h = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth || canvas.parentElement?.clientWidth || window.innerWidth;
    h = canvas.clientHeight || canvas.parentElement?.clientHeight || window.innerHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function add(x, y, o) {
    particles.push({
      x, y, vx: 0, vy: 0, life: 1, size: 7, rot: Math.random() * 6,
      vr: (Math.random() - 0.5) * 0.4, g: 0.28, shape: 'rect', color: '#fff', decay: 0.013, ...o,
    });
  }

  function ensureLoop() {
    if (raf != null) return;
    const loop = () => {
      ctx.clearRect(0, 0, w, h);
      for (const p of particles) {
        p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life -= p.decay;
      }
      particles = particles.filter((p) => p.life > 0 && p.y < h + 50);
      for (const p of particles) {
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life));
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.fillStyle = p.color;
        if (p.shape === 'circ') {
          ctx.beginPath(); ctx.arc(0, 0, p.size / 2, 0, 7); ctx.fill();
        } else {
          ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 1.3);
        }
        ctx.restore();
      }
      if (particles.length === 0) { raf = null; return; } // idle until next burst
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  }

  function burst(x, y, n = 46, power = 8) {
    for (let i = 0; i < n; i += 1) {
      const a = Math.random() * Math.PI * 2;
      const s = Math.random() * power + 2;
      add(x, y, {
        vx: Math.cos(a) * s, vy: Math.sin(a) * s - 2,
        size: Math.random() * 8 + 4, color: COLORS[i % COLORS.length], g: 0.3,
        shape: Math.random() < 0.5 ? 'rect' : 'circ',
      });
    }
    ensureLoop();
  }

  function rain(n = 130) {
    for (let i = 0; i < n; i += 1) {
      add(Math.random() * w, -20 - Math.random() * 200, {
        vx: (Math.random() - 0.5) * 2, vy: Math.random() * 3 + 2,
        size: Math.random() * 9 + 5, color: COLORS[i % COLORS.length],
        life: 1.6, g: 0.1, decay: 0.008, vr: (Math.random() - 0.5) * 0.5,
      });
    }
    ensureLoop();
  }

  resize();
  window.addEventListener('resize', resize);

  return {
    burst,
    rain,
    resize,
    destroy() {
      if (raf != null) cancelAnimationFrame(raf);
      raf = null;
      particles = [];
      window.removeEventListener('resize', resize);
    },
  };
}
