//! XTEST is routed through this connection's private MPX master pair.
//! Never warp, save/restore, or inject through the user's core pointer.
use crate::{Result, STOP};
use std::{sync::atomic::Ordering, thread::sleep, time::Duration};
use x11rb::{
    connection::Connection,
    protocol::{
        xinput::{self, ConnectionExt as _},
        xproto::*,
        xtest::ConnectionExt as _,
    },
    rust_connection::RustConnection,
};

fn remove(c: &RustConnection, id: u16) -> Result<()> {
    c.xinput_xi_change_hierarchy(&[xinput::HierarchyChange {
        len: 3,
        data: xinput::HierarchyChangeData::RemoveMaster(xinput::HierarchyChangeDataRemoveMaster {
            deviceid: id,
            return_mode: xinput::ChangeMode::FLOAT,
            return_pointer: 0,
            return_keyboard: 0,
        }),
    }])?
    .check()?;
    Ok(())
}
struct Pair<'a> {
    c: &'a RustConnection,
    id: u16,
}
impl Drop for Pair<'_> {
    fn drop(&mut self) {
        if let Err(e) = remove(self.c, self.id) {
            eprintln!("master cleanup failed: {e}");
        }
    }
}

pub fn devices(c: &RustConnection) -> Result<()> {
    c.xinput_xi_query_version(2, 0)?.reply()?;
    for d in c.xinput_xi_query_device(0u16)?.reply()?.infos {
        println!("{} {}", d.deviceid, String::from_utf8_lossy(&d.name));
    }
    Ok(())
}
fn reap(c: &RustConnection) -> Result<()> {
    for d in c.xinput_xi_query_device(0u16)?.reply()?.infos {
        let name = String::from_utf8_lossy(&d.name);
        if d.type_ != xinput::DeviceType::MASTER_POINTER {
            continue;
        }
        if let Some(pid) = name
            .strip_prefix("cua-agent-")
            .and_then(|s| s.strip_suffix(" pointer"))
            .and_then(|s| s.parse::<u32>().ok())
        {
            if !std::path::Path::new(&format!("/proc/{pid}")).exists() {
                remove(c, d.deviceid)?;
            }
        }
    }
    Ok(())
}
// A separate process observes pipe EOF even if the click process is SIGKILLed.
struct Watcher(std::process::Child);
impl Drop for Watcher {
    fn drop(&mut self) {
        drop(self.0.stdin.take());
        let _ = self.0.wait();
    }
}
pub fn watch(c: &RustConnection, pid: u32) -> Result<()> {
    use std::io::{Read, Write};
    c.xinput_xi_query_version(2, 0)?.reply()?;
    println!("ready");
    std::io::stdout().flush()?;
    let _ = std::io::stdin().read(&mut [0u8; 1]);
    // Allow already-submitted creation requests from the dying connection to settle.
    sleep(Duration::from_millis(100));
    let name = format!("cua-agent-{pid} pointer");
    for d in c.xinput_xi_query_device(0u16)?.reply()?.infos {
        if d.name == name.as_bytes() && d.type_ == xinput::DeviceType::MASTER_POINTER {
            remove(c, d.deviceid)?;
        }
    }
    Ok(())
}
fn watcher() -> Result<Watcher> {
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
    };
    let mut child = Command::new(std::env::current_exe()?)
        .args(["watch", &std::process::id().to_string()])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()?;
    let mut line = String::new();
    BufReader::new(child.stdout.take().ok_or("watcher stdout missing")?).read_line(&mut line)?;
    if line.trim() != "ready" {
        let _ = child.wait();
        return Err("pointer cleanup watcher failed".into());
    }
    Ok(Watcher(child))
}
pub fn click(
    c: &RustConnection,
    screen: usize,
    w: Window,
    x: i16,
    y: i16,
    button: u8,
) -> Result<()> {
    if !(1..=3).contains(&button) {
        return Err("button must be 1, 2, or 3".into());
    }
    let root = c.setup().roots[screen].root;
    let g = c.get_geometry(w)?.reply()?;
    if x < 0 || y < 0 || x as u16 >= g.width || y as u16 >= g.height {
        return Err("click point outside target window".into());
    }
    if c.get_window_attributes(w)?.reply()?.map_state != MapState::VIEWABLE {
        return Err("target is not visible".into());
    }
    let p = c.translate_coordinates(w, root, x, y)?.reply()?;
    c.xinput_xi_query_version(2, 0)?.reply()?;
    reap(c)?;
    let cp = c.xinput_xi_get_client_pointer(0u32)?.reply()?;
    let human = if cp.set {
        cp.deviceid
    } else {
        c.xinput_xi_query_device(0u16)?
            .reply()?
            .infos
            .into_iter()
            .find(|d| {
                d.type_ == xinput::DeviceType::MASTER_POINTER && d.name == b"Virtual core pointer"
            })
            .ok_or("cannot identify human core pointer")?
            .deviceid
    };
    let before = c.xinput_xi_query_pointer(root, human)?.reply()?;
    let _watcher = watcher()?;
    let name = format!("cua-agent-{}", std::process::id());
    c.xinput_xi_change_hierarchy(&[xinput::HierarchyChange {
        len: (8 + name.len()).div_ceil(4) as u16,
        data: xinput::HierarchyChangeData::AddMaster(xinput::HierarchyChangeDataAddMaster {
            name: name.as_bytes().to_vec(),
            send_core: true,
            enable: true,
        }),
    }])?
    .check()?;
    let all = c.xinput_xi_query_device(0u16)?.reply()?.infos;
    let d = all
        .iter()
        .find(|d| d.name == format!("{name} pointer").as_bytes())
        .ok_or("new master pointer missing")?;
    let pair = Pair { c, id: d.deviceid };
    if pair.id == human {
        return Err("refusing to inject through human pointer".into());
    }
    c.xinput_xi_set_client_pointer(0u32, pair.id)?.check()?;
    c.xinput_xi_set_focus(w, x11rb::CURRENT_TIME, d.attachment)?
        .check()?;
    c.xtest_fake_input(MOTION_NOTIFY_EVENT, 0, 0, root, p.dst_x, p.dst_y, 0)?
        .check()?;
    sleep(Duration::from_millis(80));
    // QueryPointer respects ShapeInput, including the overlay's empty input shape.
    let mut child = c.query_pointer(root)?.reply()?.child;
    let mut hits_target = false;
    for _ in 0..64 {
        if child == w {
            hits_target = true;
            break;
        }
        if child == 0 {
            break;
        }
        child = c.query_pointer(child)?.reply()?.child;
    }
    if !hits_target {
        return Err("target is obscured at click point; no click sent".into());
    }
    if STOP.load(Ordering::Relaxed) {
        return Err("interrupted before click".into());
    }
    c.xtest_fake_input(BUTTON_PRESS_EVENT, button, 0, root, 0, 0, 0)?
        .check()?;
    sleep(Duration::from_millis(40));
    // Always release, including when a signal arrived during the press.
    c.xtest_fake_input(BUTTON_RELEASE_EVENT, button, 0, root, 0, 0, 0)?
        .check()?;
    sleep(Duration::from_millis(80));
    let after = c.xinput_xi_query_pointer(root, human)?.reply()?;
    drop(pair);
    c.get_input_focus()?.reply()?;
    println!(
        "injected button={button} global={},{} human_before={},{} human_after={},{}",
        p.dst_x,
        p.dst_y,
        before.root_x / 65536,
        before.root_y / 65536,
        after.root_x / 65536,
        after.root_y / 65536
    );
    Ok(())
}
