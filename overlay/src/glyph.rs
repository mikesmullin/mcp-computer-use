use x11rb::protocol::xproto::Rectangle;
pub const SIZE: u16 = 36;
pub const HOT: i16 = 3;
fn inside(x: f64, y: f64) -> bool {
    let p = [
        (3., 3.),
        (3., 27.),
        (9., 21.),
        (14., 32.),
        (20., 29.),
        (15., 19.),
        (25., 19.),
    ];
    let mut yes = false;
    for i in 0..p.len() {
        let (a, b) = (p[i], p[(i + 1) % p.len()]);
        if (a.1 > y) != (b.1 > y) && x < (b.0 - a.0) * (y - a.1) / (b.1 - a.1) + a.0 {
            yes = !yes;
        }
    }
    yes
}
pub fn pixels() -> Vec<(i16, i16, bool)> {
    let mut out = Vec::new();
    for y in 0..SIZE as i16 {
        for x in 0..SIZE as i16 {
            let fill = inside(x as f64 + 0.5, y as f64 + 0.5);
            let halo = (-2..=2)
                .any(|dy| (-2..=2).any(|dx| inside((x + dx) as f64 + 0.5, (y + dy) as f64 + 0.5)));
            if fill || halo {
                out.push((x, y, fill));
            }
        }
    }
    out
}
pub fn shape(pixels: &[(i16, i16, bool)], alpha: f64) -> Vec<Rectangle> {
    // Ordered coverage fade works on bare X11 without a compositor.
    const B: [[u8; 4]; 4] = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
    pixels
        .iter()
        .filter(|(x, y, _)| (B[*y as usize % 4][*x as usize % 4] as f64 + 0.5) / 16. < alpha)
        .map(|&(x, y, _)| Rectangle {
            x,
            y,
            width: 1,
            height: 1,
        })
        .collect()
}
pub fn ease(t: f64) -> f64 {
    let t = t.clamp(0., 1.);
    if t < 0.5 {
        2. * t * t
    } else {
        1. - (-2. * t + 2.).powi(2) / 2.
    }
}
pub fn duration(from: (f64, f64), to: (f64, f64)) -> f64 {
    ((to.0 - from.0).hypot(to.1 - from.1) * 0.0004 + 0.15).clamp(0.15, 0.8)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn coverage() {
        let p = pixels();
        assert_eq!(p, pixels());
        assert!(!p.is_empty());
        assert_eq!(shape(&p, 1.).len(), p.len());
        assert!(shape(&p, 0.).is_empty());
        assert!(p
            .iter()
            .all(|&(x, y, _)| x >= 0 && y >= 0 && x < SIZE as i16 && y < SIZE as i16));
    }
    #[test]
    fn easing() {
        assert_eq!(ease(0.), 0.);
        assert_eq!(ease(1.), 1.);
        for i in 0..100 {
            let t = i as f64 / 100.;
            assert!(ease(t) <= ease(t + 0.01));
            assert!((ease(t) + ease(1. - t) - 1.).abs() < 1e-12);
        }
        assert_eq!(duration((0., 0.), (1e6, 0.)), 0.8);
    }
}
