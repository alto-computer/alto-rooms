//! TypeSafe Jev: one Choice question per document (spec §3). The only file that talks to TypeSafe.
use crate::rules::Answer;
use serde_json::{json, Value};
use std::time::Duration;

pub const KEY_ENV: &str = "TYPESAFE_API_KEY";
/// Test hook: point the client at a fake server.
pub const URL_ENV: &str = "TYPESAFE_URL";
pub const DEFAULT_URL: &str = "https://api.typesafe.ai/v1/systemone";
const QUESTION: &str = "room";
const RETRIES: u32 = 3;

#[derive(Debug, Clone, PartialEq)]
pub enum JevError {
    /// 401: the key is wrong; stop asking until it changes.
    Unauthorized,
    Other(String),
}

impl std::fmt::Display for JevError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self { JevError::Unauthorized => write!(f, "TypeSafe rejected the key (401)"), JevError::Other(e) => write!(f, "{e}") }
    }
}

/// Jev's answer plus what gets recorded: the top three probabilities and the input tokens.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub answer: Answer,
    pub top: Vec<(String, f64)>,
    pub input_tokens: u64,
}

pub trait Classifier: Sync {
    fn model(&self) -> &str;
    fn ask(&self, state: &str, options: &[(String, String)]) -> Result<Reply, JevError>;
}

pub struct Jev {
    pub url: String,
    pub key: String,
    pub model: String,
    agent: ureq::Agent,
}

impl Jev {
    pub fn new(key: String, model: String) -> Jev {
        let url = std::env::var(URL_ENV).ok().filter(|s| !s.is_empty()).unwrap_or_else(|| DEFAULT_URL.into());
        let agent = ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(10)).timeout(Duration::from_secs(30)).build();
        Jev { url, key, model, agent }
    }
}

/// The request body (spec §3).
pub fn body(model: &str, state: &str, options: &[(String, String)]) -> Value {
    let criteria: serde_json::Map<String, Value> = options.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
    json!({
        "model": model,
        "state": state,
        "questions": { QUESTION: { "type": "choice", "instructions": crate::doc::INSTRUCTIONS, "criteria": criteria } }
    })
}

/// Reads `answers.room`; `none` (or anything not offered) becomes no room.
pub fn parse(v: &Value, options: &[(String, String)]) -> Result<Reply, JevError> {
    let a = &v["answers"][QUESTION];
    let choice = a["choice"].as_str().ok_or_else(|| JevError::Other(format!("no choice in answer: {v}")))?;
    let confidence = a["confidence"].as_f64().ok_or_else(|| JevError::Other("no confidence in answer".into()))?;
    let offered = options.iter().any(|(k, _)| k == choice);
    let choice = (offered && choice != crate::doc::NONE_KEY).then(|| choice.to_string());
    let mut top: Vec<(String, f64)> = a["probabilities"].as_object().map(|m| m.iter().filter_map(|(k, p)| Some((k.clone(), p.as_f64()?))).collect()).unwrap_or_default();
    top.sort_by(|x, y| y.1.total_cmp(&x.1));
    top.truncate(3);
    Ok(Reply { answer: Answer { choice, confidence }, top, input_tokens: v["usage"]["input_tokens"].as_u64().unwrap_or(0) })
}

impl Classifier for Jev {
    fn model(&self) -> &str { &self.model }

    fn ask(&self, state: &str, options: &[(String, String)]) -> Result<Reply, JevError> {
        let req = body(&self.model, state, options);
        let mut wait = Duration::from_millis(500);
        for attempt in 0..=RETRIES {
            let r = self.agent.post(&self.url).set("Authorization", &format!("Bearer {}", self.key)).send_json(req.clone());
            match r {
                Ok(resp) => return parse(&resp.into_json::<Value>().map_err(|e| JevError::Other(e.to_string()))?, options),
                Err(ureq::Error::Status(401, _)) => return Err(JevError::Unauthorized),
                Err(ureq::Error::Status(code @ (429 | 529 | 500..=599), _)) if attempt < RETRIES => {
                    eprintln!("rooms-sort: TypeSafe answered {code}; retrying in {wait:?}");
                }
                Err(ureq::Error::Status(code, resp)) => {
                    return Err(JevError::Other(format!("TypeSafe answered {code}: {}", resp.into_string().unwrap_or_default())))
                }
                Err(e) if attempt < RETRIES => eprintln!("rooms-sort: {e}; retrying in {wait:?}"),
                Err(e) => return Err(JevError::Other(e.to_string())),
            }
            std::thread::sleep(wait);
            wait *= 2;
        }
        Err(JevError::Other("TypeSafe kept failing".into()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> Vec<(String, String)> { vec![("r_a".into(), "alto".into()), ("none".into(), "x".into())] }

    #[test]
    fn body_has_one_choice_question() {
        let b = body("jev-1.13.0", "S", &opts());
        assert_eq!(b["questions"]["room"]["type"], "choice");
        assert_eq!(b["questions"]["room"]["criteria"]["r_a"], "alto");
        assert_eq!(b["model"], "jev-1.13.0");
    }

    #[test]
    fn parse_room_none_and_unknown() {
        let v = json!({"answers": {"room": {"type": "choice", "choice": "r_a", "probabilities": {"r_a": 0.8, "none": 0.2}, "confidence": 0.75}},
                       "usage": {"input_tokens": 612}});
        let r = parse(&v, &opts()).unwrap();
        assert_eq!(r.answer, Answer { choice: Some("r_a".into()), confidence: 0.75 });
        assert_eq!(r.top, vec![("r_a".to_string(), 0.8), ("none".to_string(), 0.2)]);
        assert_eq!(r.input_tokens, 612);
        let none = json!({"answers": {"room": {"choice": "none", "confidence": 0.6}}});
        assert_eq!(parse(&none, &opts()).unwrap().answer.choice, None);
        let odd = json!({"answers": {"room": {"choice": "r_zzz", "confidence": 0.9}}});
        assert_eq!(parse(&odd, &opts()).unwrap().answer.choice, None);
        assert!(parse(&json!({}), &opts()).is_err());
    }
}
