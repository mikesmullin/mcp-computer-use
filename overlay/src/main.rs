mod glyph;
mod input;
mod motion;
mod ops;
mod window;
use std::{
    error::Error,
    sync::atomic::{AtomicBool, Ordering},
};
use x11rb::{connection::Connection, protocol::xproto::ConnectionExt};
type Result<T> = std::result::Result<T, Box<dyn Error>>;
static STOP: AtomicBool = AtomicBool::new(false);
extern "C" fn stop(_: libc::c_int) {
    STOP.store(true, Ordering::Relaxed);
}
fn run() -> Result<()> {
    // Handlers only set an atomic flag; X cleanup happens on the owning thread.
    unsafe {
        libc::signal(libc::SIGTERM, stop as *const () as usize);
        libc::signal(libc::SIGINT, stop as *const () as usize);
    }
    let args: Vec<_> = std::env::args().collect();
    let (c, screen) = x11rb::connect(None).map_err(|e| format!("no X display: {e}"))?;
    match args.get(1).map(String::as_str).unwrap_or("serve") {
        "serve" => window::serve(c, screen),
        "click" if args.len() == 6 => input::click(
            &c,
            screen,
            args[2].parse()?,
            args[3].parse()?,
            args[4].parse()?,
            args[5].parse()?,
        ),
        "geometry" | "capture-geometry" if args.len() == 3 => {
            let w = args[2].parse()?;
            let g = c.get_geometry(w)?.reply()?;
            let p = c
                .translate_coordinates(w, c.setup().roots[screen].root, 0, 0)?
                .reply()?;
            if args[1] == "capture-geometry" {
                let root = c.get_geometry(c.setup().roots[screen].root)?.reply()?;
                if p.dst_x < 0
                    || p.dst_y < 0
                    || i32::from(p.dst_x) + i32::from(g.width) > i32::from(root.width)
                    || i32::from(p.dst_y) + i32::from(g.height) > i32::from(root.height)
                {
                    return Err(
                        "capture requires a window fully inside the root framebuffer".into(),
                    );
                }
            }
            println!("{} {} {} {}", p.dst_x, p.dst_y, g.width, g.height);
            Ok(())
        }
        "devices" => input::devices(&c),
        "watch" if args.len() == 3 => input::watch(&c, args[2].parse()?),
        _ => Err(
            "usage: cua-overlay [serve | click WINDOW X Y BUTTON | geometry WINDOW | devices]"
                .into(),
        ),
    }
}
fn main() {
    if let Err(e) = run() {
        eprintln!("cua-overlay: {e}");
        std::process::exit(1);
    }
}
