use std::{
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
    time::Duration,
};
use x11rb::{
    connection::Connection,
    protocol::{
        shape::{ConnectionExt as _, SK},
        xproto::ConnectionExt as _,
    },
};
#[test]
#[ignore = "requires an authorized live X11 desktop"]
fn overlay_shapes_fade_eof_and_focus() {
    check("400", true);
}
#[test]
#[ignore = "requires an authorized live X11 desktop"]
fn overlay_persists_between_moves() {
    check("0", false);
}
fn check(idle: &str, fade: bool) {
    assert_eq!(std::env::var("CUA_OVERLAY_X").as_deref(), Ok("1"));
    let (c, s) = x11rb::connect(None).unwrap();
    let root = c.setup().roots[s].root;
    let focus = c.get_input_focus().unwrap().reply().unwrap().focus;
    let pointer = c.query_pointer(root).unwrap().reply().unwrap();
    let mut child = Command::new(env!("CARGO_BIN_EXE_cua-overlay"))
        .arg("serve")
        .env("CUA_CURSOR_IDLE_MS", idle)
        .env("CUA_CURSOR_FADE_MS", "200")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut out = BufReader::new(child.stdout.take().unwrap());
    let mut line = String::new();
    out.read_line(&mut line).unwrap();
    let window: u32 = line.split_whitespace().nth(1).unwrap().parse().unwrap();
    writeln!(child.stdin.as_mut().unwrap(), "show 100 100").unwrap();
    line.clear();
    out.read_line(&mut line).unwrap();
    assert_eq!(line.trim(), "ok");
    assert!(c
        .shape_get_rectangles(window, SK::INPUT)
        .unwrap()
        .reply()
        .unwrap()
        .rectangles
        .is_empty());
    assert!(!c
        .shape_get_rectangles(window, SK::BOUNDING)
        .unwrap()
        .reply()
        .unwrap()
        .rectangles
        .is_empty());
    assert_eq!(c.get_input_focus().unwrap().reply().unwrap().focus, focus);
    let after = c.query_pointer(root).unwrap().reply().unwrap();
    assert_eq!(
        (after.root_x, after.root_y),
        (pointer.root_x, pointer.root_y)
    );
    std::thread::sleep(Duration::from_millis(if fade { 550 } else { 5500 }));
    assert_eq!(
        c.shape_get_rectangles(window, SK::BOUNDING)
            .unwrap()
            .reply()
            .unwrap()
            .rectangles
            .is_empty(),
        fade
    );
    drop(child.stdin.take());
    assert!(child.wait().unwrap().success());
    assert!(c.get_geometry(window).unwrap().reply().is_err());
}
