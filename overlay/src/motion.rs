//! CUA-inspired curved travel: eased cubic arcs with per-move variation.
//! The endpoint is exact; decorative motion never changes action coordinates.
use crate::glyph;
pub type Point = (f64, f64);
#[derive(Clone, Copy)]
pub struct Path {
    points: [Point; 4],
}
impl Path {
    pub fn new(from: Point, to: Point, seed: u64, bounds: Point) -> Self {
        let dx = to.0 - from.0;
        let dy = to.1 - from.1;
        let distance = dx.hypot(dy).max(1.);
        // Small deterministic mixer makes trajectories reproducible in tests.
        let mut bits = seed
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        bits ^= bits >> 29;
        let amount = 0.14 + (bits & 255) as f64 / 255. * 0.14;
        let sign = if bits & 256 == 0 { 1. } else { -1. };
        let bend = (distance * amount).min(200.) * sign;
        let normal = (-dy / distance, dx / distance);
        let asymmetry = 0.5 + ((bits >> 10) & 255) as f64 / 255. * 0.7;
        let second = if bits & 512 == 0 {
            asymmetry
        } else {
            -0.35 * asymmetry
        };
        let control = |along: f64, side: f64| {
            (
                (from.0 + dx * along + normal.0 * bend * side).clamp(0., bounds.0 - 1.),
                (from.1 + dy * along + normal.1 * bend * side).clamp(0., bounds.1 - 1.),
            )
        };
        Self {
            points: [from, control(0.28, 1.), control(0.72, second), to],
        }
    }
    pub fn sample(&self, t: f64) -> Point {
        if t <= 0. {
            return self.points[0];
        }
        if t >= 1. {
            return self.points[3];
        }
        let t = glyph::ease(t);
        let u = 1. - t;
        let weights = [u * u * u, 3. * u * u * t, 3. * u * t * t, t * t * t];
        self.points
            .iter()
            .zip(weights)
            .fold((0., 0.), |(x, y), (p, w)| (x + p.0 * w, y + p.1 * w))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn curved_varied_exact_and_bounded() {
        let from = (100., 300.);
        let to = (900., 300.);
        let bounds = (1000., 600.);
        let a = Path::new(from, to, 1, bounds);
        let b = Path::new(from, to, 2, bounds);
        assert_eq!(a.sample(0.), from);
        assert_eq!(a.sample(1.), to);
        assert!((a.sample(0.5).1 - 300.).abs() > 10.);
        assert_ne!(a.sample(0.5), b.sample(0.5));
        for seed in 0..20 {
            for from in [(0., 0.), (999., 599.), (0., 599.)] {
                let path = Path::new(from, to, seed, bounds);
                for i in 0..=100 {
                    let p = path.sample(i as f64 / 100.);
                    assert!(p.0 >= 0. && p.0 < 1000. && p.1 >= 0. && p.1 < 600.);
                }
            }
        }
        assert_eq!(Path::new(from, from, 1, bounds).sample(0.5), from);
    }
}
