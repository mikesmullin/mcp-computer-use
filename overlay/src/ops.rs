use crate::Result;
#[derive(Debug, PartialEq)]
pub enum Op {
    Show(i16, i16),
    Move(i16, i16),
    Fade(u64),
    Typing(bool),
    Quit,
}
pub fn parse(line: &str) -> Result<Op> {
    let a: Vec<_> = line.split_whitespace().collect();
    match a.as_slice() {
        ["show", x, y] => Ok(Op::Show(x.parse()?, y.parse()?)),
        ["move", x, y] => Ok(Op::Move(x.parse()?, y.parse()?)),
        ["fade", ms] => {
            let ms = ms.parse()?;
            if ms > 60_000 {
                return Err("fade must be <= 60000 ms".into());
            }
            Ok(Op::Fade(ms))
        }
        ["typing", "0"] => Ok(Op::Typing(false)),
        ["typing", "1"] => Ok(Op::Typing(true)),
        ["quit"] => Ok(Op::Quit),
        _ => Err("expected show X Y, move X Y, fade MS, or quit".into()),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn protocol() {
        assert_eq!(parse("show 1 2\r\n").unwrap(), Op::Show(1, 2));
        for bad in [
            "",
            "show 1",
            "move 99999 2",
            "show NaN 2",
            "quit extra",
            "fade 60001",
        ] {
            assert!(parse(bad).is_err(), "{bad}");
        }
    }
}
