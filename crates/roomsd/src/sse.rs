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

/// The broadcast stream with every lag (the client fell behind and missed events) turned into a
/// `resync` from `resync()` (spec §3). Back-to-back lags collapse into one: a single refetch
/// covers them all, and one per lag would make a slow client refetch over and over.
fn with_lag_resyncs<E>(
    events: impl Stream<Item = Result<RoomsEvent, E>>,
    resync: impl Fn() -> RoomsEvent,
) -> impl Stream<Item = RoomsEvent> {
    let mut lagging = false;
    events.filter_map(move |r| match r {
        Ok(ev) => { lagging = false; Some(ev) }
        Err(_) if lagging => None,
        Err(_) => { lagging = true; Some(resync()) }
    })
}

pub async fn events(State(st): State<AppState>) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let core = st.core.clone();
    // Subscribe first, then read seq: nothing emitted after this point can be missed.
    let rx = st.core.subscribe();
    // Every (re)connection starts with resync{roomId: null} at the current seq, so a client that
    // reconnected (EventSource does this silently) knows to re-fetch its snapshots (spec §3/§5 S3).
    let hello = to_sse(&RoomsEvent { seq: st.core.current_seq(), kind: EventKind::Resync { room_id: None } });
    let resync = move || RoomsEvent { seq: core.current_seq(), kind: EventKind::Resync { room_id: None } };
    let live = with_lag_resyncs(BroadcastStream::new(rx), resync).map(|ev| Ok(to_sse(&ev)));
    let stream = futures::stream::once(async move { Ok(hello) }).chain(live);
    Sse::new(stream).keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(seq: u64) -> RoomsEvent { RoomsEvent { seq, kind: EventKind::PluginsChanged {} } }

    #[tokio::test]
    async fn back_to_back_lags_become_one_resync() {
        let input = vec![Ok(ev(1)), Err(()), Err(()), Err(()), Ok(ev(5)), Err(()), Ok(ev(7))];
        let out: Vec<RoomsEvent> = with_lag_resyncs(futures::stream::iter(input), || RoomsEvent {
            seq: 0, kind: EventKind::Resync { room_id: None },
        }).collect().await;
        let kinds: Vec<String> = out.iter().map(|e| match &e.kind {
            EventKind::Resync { .. } => "resync".to_string(),
            _ => e.seq.to_string(),
        }).collect();
        assert_eq!(kinds, ["1", "resync", "5", "resync", "7"]);
    }
}
