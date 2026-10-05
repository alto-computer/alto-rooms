use crate::AppState;
use axum::extract::State;
use axum::http::StatusCode;

pub async fn events(State(_st): State<AppState>) -> StatusCode { StatusCode::NOT_IMPLEMENTED }
