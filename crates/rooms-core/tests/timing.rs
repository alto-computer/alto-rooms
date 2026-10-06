//! Latency tests over a 3000-file room. They live in their own test binary so they don't share
//! CPU with the rest of the suite: cargo runs test binaries one after another, and these measure
//! how long the core's write lock is held, which parallel tests would skew.
use rooms_core::RoomsCore;
use rooms_protocol::*;
use std::fs;
use std::time::{Duration, Instant};

fn slow(d: Duration) -> Duration {
    let k = std::env::var("ROOMS_TEST_SLOWDOWN").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(1.0);
    d.mul_f64(k)
}

fn wait_for(rx: &mut tokio::sync::broadcast::Receiver<RoomsEvent>, pred: impl Fn(&EventKind) -> bool, max: Duration) -> Vec<RoomsEvent> {
    let start = Instant::now();
    let mut got = Vec::new();
    while start.elapsed() < max {
        match rx.try_recv() {
            Ok(e) => { let hit = pred(&e.kind); got.push(e); if hit { return got; } }
            Err(_) => std::thread::sleep(Duration::from_millis(20)),
        }
    }
    panic!("timed out; got {got:?}");
}

#[test]
fn api_calls_stay_fast_during_big_backfill() {
    let d = tempfile::tempdir().unwrap();
    let big = d.path().join("big");
    fs::create_dir_all(&big).unwrap();
    let head = format!("<title>t</title>{}", "x".repeat(20_000));
    for i in 0..3000 { fs::write(big.join(format!("{i}.html")), &head).unwrap(); }
    let core = RoomsCore::open(d.path()).unwrap();
    let c = core.clone();
    let t = std::thread::spawn(move || c.backfill_all().unwrap());
    let mut worst = Duration::ZERO;
    while !t.is_finished() {
        let s = Instant::now();
        let _ = core.list_rooms();
        let _ = core.current_seq();
        worst = worst.max(s.elapsed());
        std::thread::sleep(Duration::from_millis(5));
    }
    t.join().unwrap();
    assert!(worst < slow(Duration::from_millis(150)), "worst {worst:?}");
}

#[test]
fn one_new_file_in_big_room_is_added_within_a_second() {
    let d = tempfile::tempdir().unwrap();
    let big = d.path().join("big");
    fs::create_dir_all(&big).unwrap();
    for i in 0..3000 { fs::write(big.join(format!("{i}.html")), "<title>t</title>").unwrap(); }
    let (core, _w) = rooms_core::watch::open_and_watch(d.path()).unwrap();
    let id = core.list_rooms().into_iter().find(|r| r.name == "big").unwrap().id;
    let deadline = Instant::now() + Duration::from_secs(30);
    while core.list_artifacts(&id).unwrap().len() < 3000 { assert!(Instant::now() < deadline); std::thread::sleep(Duration::from_millis(50)); }
    let mut rx = core.subscribe();
    let s = Instant::now();
    fs::write(big.join("fresh.html"), "<title>fresh</title>").unwrap();
    wait_for(&mut rx, |k| matches!(k, EventKind::ArtifactAdded { artifact } if artifact.rel_path == "fresh.html"), slow(Duration::from_secs(2)));
    assert!(s.elapsed() < slow(Duration::from_secs(1)), "{:?}", s.elapsed());
}
