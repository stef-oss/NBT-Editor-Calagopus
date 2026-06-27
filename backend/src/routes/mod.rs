use shared::State;
use utoipa_axum::router::OpenApiRouter;

mod client_server;

pub fn client_server_router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .nest("/nbt-editor", client_server::router(state))
        .with_state(state.clone())
}
