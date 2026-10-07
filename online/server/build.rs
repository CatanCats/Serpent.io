// Compiles the game simulation (sim-server.c, the offline rules extended for many
// players) to native machine code and links it into the server.
fn main() {
    println!("cargo:rerun-if-changed=sim-server.c");
    // which commit this is, shown at /status (the deploy passes it in; a git checkout finds it itself)
    println!("cargo:rerun-if-env-changed=SERPENT_VERSION");
    if std::path::Path::new("../../.git/logs/HEAD").exists() { println!("cargo:rerun-if-changed=../../.git/logs/HEAD"); } // a new commit
    let v = std::env::var("SERPENT_VERSION").ok().filter(|v| !v.is_empty()).or_else(|| {
        let o = std::process::Command::new("git").args(["rev-parse", "--short", "HEAD"]).output().ok()?;
        o.status.success().then(|| String::from_utf8_lossy(&o.stdout).trim().to_string())
    });
    println!("cargo:rustc-env=SERPENT_VERSION={}", v.unwrap_or_else(|| "dev".into()));
    let mut b = cc::Build::new();
    b.file("sim-server.c").opt_level(3).flag_if_supported("-Wno-misleading-indentation");
    // Tune for the CPU it is built on (the server builds itself). SERPENT_PORTABLE=1 to skip.
    if std::env::var("SERPENT_PORTABLE").is_err() {
        b.flag_if_supported("-march=native");
    }
    b.compile("sim");
}
