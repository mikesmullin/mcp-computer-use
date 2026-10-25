use crate::{
    glyph,
    ops::{self, Op},
    Result, STOP,
};
use std::{
    io::{self, BufRead, Read, Write},
    sync::{atomic::Ordering, mpsc},
    time::{Duration, Instant},
};
use x11rb::{
    connection::Connection,
    protocol::{
        shape::{ConnectionExt as _, SK, SO},
        xproto::*,
    },
    rust_connection::RustConnection,
    wrapper::ConnectionExt as _,
};
fn env_ms(name: &str, default: u64) -> Result<u64> {
    match std::env::var(name) {
        Ok(v) => {
            let n = v.parse()?;
            if n > 3_600_000 {
                return Err(format!("{name} exceeds 3600000").into());
            }
            Ok(n)
        }
        Err(_) => Ok(default),
    }
}
fn reply(s: &str) {
    println!("{s}");
    let _ = io::stdout().flush();
}
type Motion = (crate::motion::Path, Instant, f64);
pub fn serve(c: RustConnection, screen: usize) -> Result<()> {
    c.shape_query_version()?.reply()?;
    let s = &c.setup().roots[screen];
    let w = c.generate_id()?;
    c.create_window(
        s.root_depth,
        w,
        s.root,
        0,
        0,
        glyph::SIZE,
        glyph::SIZE,
        0,
        WindowClass::INPUT_OUTPUT,
        s.root_visual,
        &CreateWindowAux::new()
            .override_redirect(1)
            .background_pixel(0x101827)
            .event_mask(EventMask::EXPOSURE),
    )?
    .check()?;
    c.change_property8(
        PropMode::REPLACE,
        w,
        AtomEnum::WM_CLASS,
        AtomEnum::STRING,
        b"cua-overlay\0_CUA_OVERLAY\0",
    )?
    .check()?;
    c.change_property8(
        PropMode::REPLACE,
        w,
        AtomEnum::WM_NAME,
        AtomEnum::STRING,
        b"Agent cursor",
    )?
    .check()?;
    // Cursor overlays have no external frame or compositor shadow. Picom's
    // normal window shadow otherwise produces a dark rectangle behind Shape.
    for (name, values) in [
        (b"_COMPTON_SHADOW".as_slice(), vec![0u32]),
        (b"_GTK_FRAME_EXTENTS".as_slice(), vec![0u32; 4]),
    ] {
        let atom = c.intern_atom(false, name)?.reply()?.atom;
        c.change_property32(PropMode::REPLACE, w, atom, AtomEnum::CARDINAL, &values)?
            .check()?;
    }
    let kind = c.intern_atom(false, b"_NET_WM_WINDOW_TYPE")?.reply()?.atom;
    let dnd = c
        .intern_atom(false, b"_NET_WM_WINDOW_TYPE_DND")?
        .reply()?
        .atom;
    c.change_property32(PropMode::REPLACE, w, kind, AtomEnum::ATOM, &[dnd])?
        .check()?;
    c.shape_rectangles(SO::SET, SK::INPUT, ClipOrdering::UNSORTED, w, 0, 0, &[])?
        .check()?;
    c.shape_rectangles(SO::SET, SK::BOUNDING, ClipOrdering::UNSORTED, w, 0, 0, &[])?
        .check()?;
    c.map_window(w)?.check()?;
    let color = std::env::var("CUA_CURSOR_COLOR").unwrap_or_else(|_| "4F86F7".into());
    let rgb = u32::from_str_radix(color.trim_start_matches('#'), 16)?;
    if rgb > 0xffffff {
        return Err("color must be RRGGBB".into());
    }
    let pixel = |rgb: u32| -> Result<u32> {
        Ok(c.alloc_color(
            s.default_colormap,
            ((rgb >> 16) & 255) as u16 * 257,
            ((rgb >> 8) & 255) as u16 * 257,
            (rgb & 255) as u16 * 257,
        )?
        .reply()?
        .pixel)
    };
    let normal_pixel = pixel(rgb)?;
    let typing_pixel = pixel(0xF5B942)?;
    let blue = c.generate_id()?;
    let dark = c.generate_id()?;
    c.create_gc(blue, w, &CreateGCAux::new().foreground(normal_pixel))?
        .check()?;
    c.create_gc(dark, w, &CreateGCAux::new().foreground(pixel(0x101827)?))?
        .check()?;
    let pixels = glyph::pixels();
    let fill: Vec<_> = pixels
        .iter()
        .filter(|p| p.2)
        .map(|&(x, y, _)| Rectangle {
            x,
            y,
            width: 1,
            height: 1,
        })
        .collect();
    let all = glyph::shape(&pixels, 1.);
    let (tx, rx) = mpsc::sync_channel(32);
    std::thread::spawn(move || {
        let mut input = io::stdin().lock();
        loop {
            let mut line = String::new();
            match input.by_ref().take(4097).read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > 4096 => break,
                Ok(_) => {
                    if !line.trim().is_empty() && tx.send(line).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let idle = env_ms("CUA_CURSOR_IDLE_MS", 180_000)?;
    let mut fade = env_ms("CUA_CURSOR_FADE_MS", 2500)?.min(idle);
    let mut pos: Option<(f64, f64)> = None;
    let mut movement: Option<Motion> = None;
    let mut last = Instant::now();
    let mut raise = Instant::now();
    let mut old = None;
    let mut seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_nanos() as u64;
    reply(&format!("ready {w}"));
    loop {
        if STOP.load(Ordering::Relaxed) {
            break;
        }
        let elapsed = last.elapsed().as_millis() as u64;
        let fading = idle > 0 && elapsed >= idle.saturating_sub(fade) && elapsed < idle;
        let wait = if movement.is_some() || (pos.is_some() && fading) {
            Duration::from_millis(16)
        } else {
            Duration::from_millis(80)
        };
        // One response per command. move responds only after arrival is drawn.
        if movement.is_none() {
            match rx.recv_timeout(wait) {
                Ok(line) => match ops::parse(&line) {
                    Ok(Op::Quit) => {
                        reply("ok");
                        break;
                    }
                    Ok(Op::Typing(active)) => {
                        c.change_gc(
                            blue,
                            &ChangeGCAux::new().foreground(if active {
                                typing_pixel
                            } else {
                                normal_pixel
                            }),
                        )?
                        .check()?;
                        old = None;
                        reply("ok");
                    }
                    Ok(Op::Fade(ms)) => {
                        fade = ms.min(idle);
                        reply("ok");
                    }
                    Ok(Op::Show(x, y)) | Ok(Op::Move(x, y)) => {
                        let g = c.get_geometry(s.root)?.reply()?;
                        if x < 0 || y < 0 || x as u16 >= g.width || y as u16 >= g.height {
                            reply("error point outside root");
                            continue;
                        }
                        let to = (x as f64, y as f64);
                        // Passive screenshot refreshes must not reset idle expiry.
                        // An explicit move represents a new interaction, even at the
                        // same endpoint, and must reveal the cursor again.
                        if pos == Some(to) && !line.trim_start().starts_with("move") {
                            reply("ok");
                            continue;
                        }
                        let from = pos.unwrap_or(to);
                        let duration = if line.trim_start().starts_with("move") && pos.is_some() {
                            glyph::duration(from, to)
                        } else {
                            0.
                        };
                        seed = seed.wrapping_add(1);
                        movement = Some((
                            crate::motion::Path::new(
                                from,
                                to,
                                seed,
                                (g.width as f64, g.height as f64),
                            ),
                            Instant::now(),
                            duration,
                        ));
                        last = Instant::now();
                        pos = Some(from);
                    }
                    Err(e) => reply(&format!("error {e}")),
                },
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
        } else {
            std::thread::sleep(wait);
        }
        let mut arrived = false;
        if let Some((path, start, duration)) = movement {
            let t = if duration == 0. {
                1.
            } else {
                (start.elapsed().as_secs_f64() / duration).min(1.)
            };
            pos = Some(path.sample(t));
            if t >= 1. {
                movement = None;
                last = Instant::now();
                arrived = true;
            }
        }
        let mut exposed = false;
        while let Some(e) = c.poll_for_event()? {
            if matches!(e, x11rb::protocol::Event::Expose(_)) {
                exposed = true;
            }
        }
        if let Some((x, y)) = pos {
            let elapsed = last.elapsed().as_millis() as u64;
            let alpha = if idle == 0 || movement.is_some() {
                1.
            } else if elapsed >= idle {
                0.
            } else if fade > 0 && elapsed > idle - fade {
                (idle - elapsed) as f64 / fade as f64
            } else {
                1.
            };
            let key = (
                x.round() as i16,
                y.round() as i16,
                (alpha * 16.).ceil() as u8,
            );
            if old != Some(key) || exposed {
                c.configure_window(
                    w,
                    &ConfigureWindowAux::new()
                        .x(key.0 as i32 - glyph::HOT as i32)
                        .y(key.1 as i32 - glyph::HOT as i32),
                )?;
                c.shape_rectangles(
                    SO::SET,
                    SK::BOUNDING,
                    ClipOrdering::UNSORTED,
                    w,
                    0,
                    0,
                    &glyph::shape(&pixels, alpha),
                )?;
                c.poly_fill_rectangle(w, dark, &all)?;
                c.poly_fill_rectangle(w, blue, &fill)?;
                old = Some(key);
            }
            if raise.elapsed() >= Duration::from_millis(80) || arrived {
                c.configure_window(w, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE))?;
                raise = Instant::now();
            }
        }
        c.flush()?;
        if arrived {
            c.get_input_focus()?.reply()?;
            reply("ok");
        }
    }
    c.destroy_window(w)?.check()?;
    Ok(())
}
