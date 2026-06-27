use shared::{
    State,
    extensions::{Extension, ExtensionPermissionsBuilder, ExtensionRouteBuilder},
    permissions::PermissionGroup,
};
use indexmap::IndexMap;

mod routes;
mod services;

#[derive(Default)]
pub struct ExtensionStruct;

#[async_trait::async_trait]
impl Extension for ExtensionStruct {
    async fn initialize(&mut self, _state: State) {
        tracing::info!("nbt editor extension initialized");
    }

    async fn initialize_router(
        &mut self,
        state: State,
        builder: ExtensionRouteBuilder,
    ) -> ExtensionRouteBuilder {
        builder.add_client_server_api_router(|router| router.merge(routes::client_server_router(&state)))
    }

    async fn initialize_permissions(
        &mut self,
        _state: State,
        builder: ExtensionPermissionsBuilder,
    ) -> ExtensionPermissionsBuilder {
        builder.add_server_permission_group(
            "nbt-editor",
            PermissionGroup {
                description: "Permissions for reading and editing Minecraft NBT files.",
                permissions: IndexMap::from([("view", "Allows opening .dat and .nbt files with the NBT Editor.")]),
            },
        )
    }
}
