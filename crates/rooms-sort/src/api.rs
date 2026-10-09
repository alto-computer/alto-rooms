//! roomsd's existing public API: the only way rooms-sort changes Rooms (spec §5).
use rooms_protocol::{Artifact, Room};
use serde_json::json;
use std::path::Path;
use std::time::Duration;

pub trait Rooms {
    fn rooms(&self) -> Result<Vec<Room>, String>;
    fn artifacts(&self, room_id: &str) -> Result<Vec<Artifact>, String>;
    /// `POST /v1/artifacts/move`: keeps createdAt and the Journal day.
    fn move_artifact(&self, from_room: &str, artifact_id: &str, to_room: &str) -> Result<Artifact, String>;
    fn create_room(&self, name: &str) -> Result<Room, String>;
}

pub struct Http {
    base: String,
    token: String,
    agent: ureq::Agent,
}

impl Http {
    /// `127.0.0.1:<port>` with the bearer token roomsd writes to `<home>/.rooms/token`.
    pub fn new(home: &Path, port: u16) -> Result<Http, String> {
        let path = rooms_protocol::layout::token_path(home);
        let token = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?.trim().to_string();
        let t = Duration::from_secs(10);
        let agent = ureq::AgentBuilder::new().timeout_connect(t).timeout(t).build();
        Ok(Http { base: format!("http://127.0.0.1:{port}"), token, agent })
    }

    fn get<T: serde::de::DeserializeOwned>(&self, path: &str) -> Result<T, String> {
        self.agent.get(&format!("{}{path}", self.base)).call().map_err(message)?.into_json().map_err(|e| e.to_string())
    }

    fn post<T: serde::de::DeserializeOwned>(&self, path: &str, body: serde_json::Value) -> Result<T, String> {
        self.agent.post(&format!("{}{path}", self.base)).set("Authorization", &format!("Bearer {}", self.token))
            .send_json(body).map_err(message)?.into_json().map_err(|e| e.to_string())
    }
}

fn message(e: ureq::Error) -> String {
    match e {
        ureq::Error::Status(code, r) => r.into_json::<rooms_protocol::ApiError>().map(|b| b.message).unwrap_or_else(|_| format!("roomsd returned {code}")),
        e => format!("roomsd: {e}"),
    }
}

fn seg(s: &str) -> String {
    s.bytes().map(|b| if b.is_ascii_alphanumeric() || b"-_.~".contains(&b) { (b as char).to_string() } else { format!("%{b:02X}") }).collect()
}

impl Rooms for Http {
    fn rooms(&self) -> Result<Vec<Room>, String> { self.get("/v1/rooms") }
    fn artifacts(&self, room_id: &str) -> Result<Vec<Artifact>, String> { self.get(&format!("/v1/rooms/{}/artifacts", seg(room_id))) }
    fn move_artifact(&self, from_room: &str, artifact_id: &str, to_room: &str) -> Result<Artifact, String> {
        self.post("/v1/artifacts/move", json!({"roomId": from_room, "artifactId": artifact_id, "toRoomId": to_room}))
    }
    fn create_room(&self, name: &str) -> Result<Room, String> { self.post("/v1/rooms", json!({"name": name})) }
}
