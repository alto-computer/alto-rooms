use crate::AppState;
use axum::extract::State;
use axum::response::sse::{Event, KeepAlive, Sse};
use futures::stream::Stream;
use rooms_protocol::{EventKind, RoomsEvent};
use std::convert::Infallible;
use std::time::Duration;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

fn to_sse(ev: &RoomsEvent) -> Event {
    Event::default().id(ev.seq.to_string()).data(serde_json::to_string(ev).unwrap_or_default())
}

pub async fn events(State(st): State<AppState>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let core = st.core.clone();
    let stream = BroadcastStream::new(st.core.subscribe()).map(move |r| {
        Ok(match r {
            Ok(ev) => to_sse(&ev),
            // lagged receiver: tell the client to resync (spec §3)
            Err(_) => to_sse(&RoomsEvent { seq: core.current_seq(), kind: EventKind::Resync { room_id: None } }),
        })
    });
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}
