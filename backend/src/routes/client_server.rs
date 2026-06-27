use crate::services::nbt::{self, NbtEdition, NbtNode};
use axum::{
    extract::Query,
    http::StatusCode,
};
use compact_str::ToCompactString;
use reqwest::multipart::{Form, Part};
use serde::Deserialize;
use shared::{
    ApiError, GetState, jwt::BasePayload,
    models::{
        server::{GetServer, GetServerActivityLogger},
        user::{GetPermissionManager, GetUser},
    },
    response::{ApiResponse, ApiResponseResult},
};
use tokio::io::AsyncReadExt;
use utoipa_axum::{router::OpenApiRouter, routes};

use super::super::State;

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadQuery {
    file: String,
    edition: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    file: String,
    parsed: nbt::ParsedNbt,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NbtChange {
    path: String,
    before: String,
    after: String,
}

fn scalar_display(node: &NbtNode) -> Option<String> {
    match &node.value {
        nbt::NbtValue::Byte { value } => Some(value.to_string()),
        nbt::NbtValue::Short { value } => Some(value.to_string()),
        nbt::NbtValue::Int { value } => Some(value.to_string()),
        nbt::NbtValue::Long { value } => Some(value.to_string()),
        nbt::NbtValue::Float { value } => Some(value.to_string()),
        nbt::NbtValue::Double { value } => Some(value.to_string()),
        nbt::NbtValue::String { value } => Some(value.clone()),
        _ => None,
    }
}

fn push_nbt_change(changes: &mut Vec<NbtChange>, path: &str, before: String, after: String) {
    if changes.len() < 12 {
        changes.push(NbtChange {
            path: path.to_string(),
            before,
            after,
        });
    }
}

fn collect_nbt_changes(old: &NbtNode, new: &NbtNode, path: &str, changes: &mut Vec<NbtChange>) -> usize {
    if let (Some(before), Some(after)) = (scalar_display(old), scalar_display(new)) {
        if before != after {
            push_nbt_change(changes, path, before, after);
            return 1;
        }

        return 0;
    }

    match (&old.value, &new.value) {
        (nbt::NbtValue::Compound { entries: old_entries }, nbt::NbtValue::Compound { entries: new_entries }) => {
            old_entries
                .iter()
                .zip(new_entries.iter())
                .map(|(old_entry, new_entry)| {
                    let child_path = if path.is_empty() {
                        new_entry.name.clone()
                    } else {
                        format!("{path}.{}", new_entry.name)
                    };

                    collect_nbt_changes(&old_entry.node, &new_entry.node, &child_path, changes)
                })
                .sum()
        }
        (nbt::NbtValue::List { items: old_items, .. }, nbt::NbtValue::List { items: new_items, .. }) => {
            old_items
                .iter()
                .zip(new_items.iter())
                .enumerate()
                .map(|(index, (old_item, new_item))| {
                    let child_path = format!("{path}[{index}]");
                    collect_nbt_changes(old_item, new_item, &child_path, changes)
                })
                .sum()
        }
        _ => 0,
    }
}

fn split_file_path(path: &str) -> Option<(String, String)> {
    let normalized = normalize_file_path(path)?;
    let trimmed = normalized.trim_matches('/');
    let (directory, filename) = trimmed.rsplit_once('/').unwrap_or(("", trimmed));
    if filename.is_empty() {
        return None;
    }

    Some((
        if directory.is_empty() { "/".to_string() } else { format!("/{directory}") },
        filename.to_string(),
    ))
}

fn normalize_file_path(path: &str) -> Option<String> {
    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() || trimmed.contains("..") {
        return None;
    }

    let path = if trimmed.starts_with('/') {
        trimmed
    } else {
        format!("/{trimmed}")
    };

    let lower = path.to_lowercase();
    if !lower.ends_with(".dat") && !lower.ends_with(".nbt") {
        return None;
    }

    Some(path)
}

async fn upload_file_bytes(
    state: &shared::State,
    server: &shared::models::server::Server,
    user: &shared::models::user::User,
    directory: &str,
    filename: &str,
    bytes: Vec<u8>,
) -> Result<(), anyhow::Error> {
    #[derive(serde::Serialize)]
    struct FileUploadJwt<'a> {
        #[serde(flatten)]
        base: BasePayload,

        server_uuid: uuid::Uuid,
        user_uuid: uuid::Uuid,
        unique_id: uuid::Uuid,

        ignored_files: &'a [compact_str::CompactString],
    }

    let node = server.node.fetch_cached(&state.database).await?;
    let token = node.create_jwt(
        &state.database,
        &state.jwt,
        &FileUploadJwt {
            base: BasePayload {
                scope: "file-upload".into(),
                issuer: "panel".into(),
                subject: None,
                audience: Vec::new(),
                expiration_time: Some(chrono::Utc::now().timestamp() + 900),
                not_before: None,
                issued_at: Some(chrono::Utc::now().timestamp()),
                jwt_id: user.uuid.to_compact_string(),
            },
            server_uuid: server.uuid,
            user_uuid: user.uuid,
            unique_id: uuid::Uuid::new_v4(),
            ignored_files: server.subuser_ignored_files.as_deref().unwrap_or(&[]),
        },
    )?;

    let mut url = node.public_url(state, "/upload/file").await?;
    url.set_query(Some(&format!(
        "token={}&directory={}",
        urlencoding::encode(&token),
        urlencoding::encode(directory)
    )));

    let form = Form::new().part(
        "files",
        Part::bytes(bytes)
            .file_name(filename.to_string())
            .mime_str("application/octet-stream")?,
    );

    let response = reqwest::Client::new().post(url).multipart(form).send().await?;
    if !response.status().is_success() {
        return Err(anyhow::anyhow!(
            "failed to save {filename}: {}",
            response.text().await.unwrap_or_default()
        ));
    }

    Ok(())
}

fn parse_requested_edition(value: Option<&str>) -> Result<Option<NbtEdition>, &'static str> {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        None | Some("auto") => Ok(None),
        Some(value) if value.eq_ignore_ascii_case("java") => Ok(Some(NbtEdition::Java)),
        Some(value) if value.eq_ignore_ascii_case("bedrock") => Ok(Some(NbtEdition::Bedrock)),
        Some(_) => Err("edition must be auto, java, or bedrock"),
    }
}

async fn read_file_bytes(
    state: &shared::State,
    server: &shared::models::server::Server,
    path: &str,
) -> Result<Vec<u8>, anyhow::Error> {
    let mut reader = server
        .node
        .fetch_cached(&state.database)
        .await?
        .api_client(&state.database)
        .await?
        .get_servers_server_files_contents(server.uuid, path, false, 32 * 1024 * 1024)
        .await?;

    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).await?;
    Ok(bytes)
}

#[utoipa::path(get, path = "/read", responses(
    (status = OK, body = serde_json::Value),
    (status = BAD_REQUEST, body = ApiError),
    (status = FORBIDDEN, body = ApiError),
), params(("server" = uuid::Uuid, description = "The server ID")))]
pub async fn read(
    state: GetState,
    permissions: GetPermissionManager,
    server: GetServer,
    Query(query): Query<ReadQuery>,
) -> ApiResponseResult {
    permissions.has_server_permission("files.read-content")?;

    let Some(file) = normalize_file_path(&query.file) else {
        return ApiResponse::error("enter a valid .dat or .nbt file path")
            .with_status(StatusCode::BAD_REQUEST)
            .ok();
    };

    let edition = match parse_requested_edition(query.edition.as_deref()) {
        Ok(edition) => edition,
        Err(message) => {
            return ApiResponse::error(message)
                .with_status(StatusCode::BAD_REQUEST)
                .ok();
        }
    };

    let bytes = read_file_bytes(&state, &server, &file).await?;
    let parsed = match nbt::parse_nbt(&bytes, edition) {
        Ok(parsed) => parsed,
        Err(err) => {
            return ApiResponse::error(format!("could not parse NBT: {err}"))
                .with_status(StatusCode::BAD_REQUEST)
                .ok();
        }
    };

    ApiResponse::new_serialized(serde_json::json!({ "file": file, "parsed": parsed })).ok()
}

#[utoipa::path(post, path = "/save", request_body = serde_json::Value, responses(
    (status = OK, body = serde_json::Value),
    (status = BAD_REQUEST, body = ApiError),
    (status = FORBIDDEN, body = ApiError),
), params(("server" = uuid::Uuid, description = "The server ID")))]
pub async fn save(
    state: GetState,
    permissions: GetPermissionManager,
    user: GetUser,
    server: GetServer,
    activity_logger: GetServerActivityLogger,
    axum::Json(request): axum::Json<SaveRequest>,
) -> ApiResponseResult {
    permissions.has_server_permission("files.update")?;

    let Some(file) = normalize_file_path(&request.file) else {
        return ApiResponse::error("enter a valid .dat or .nbt file path")
            .with_status(StatusCode::BAD_REQUEST)
            .ok();
    };
    let Some((directory, filename)) = split_file_path(&file) else {
        return ApiResponse::error("enter a valid .dat or .nbt file path")
            .with_status(StatusCode::BAD_REQUEST)
            .ok();
    };

    let mut changes = Vec::new();
    let changed_count = match read_file_bytes(&state, &server, &file).await {
        Ok(existing_bytes) => match nbt::parse_nbt(&existing_bytes, Some(request.parsed.edition)) {
            Ok(existing) => collect_nbt_changes(&existing.root, &request.parsed.root, &request.parsed.root_name, &mut changes),
            Err(_) => 0,
        },
        Err(_) => 0,
    };

    let bytes = match nbt::encode_nbt(&request.parsed) {
        Ok(bytes) => bytes,
        Err(err) => {
            return ApiResponse::error(format!("could not encode NBT: {err}"))
                .with_status(StatusCode::BAD_REQUEST)
                .ok();
        }
    };

    upload_file_bytes(&state, &server, &user, &directory, &filename, bytes).await?;
    activity_logger
        .log(
            "server:nbt-editor.save",
            serde_json::json!({
                "file": file,
                "changedCount": changed_count,
                "changes": changes,
            }),
        )
        .await;

    ApiResponse::new_serialized(serde_json::json!({ "file": file })).ok()
}

pub fn router(state: &State) -> OpenApiRouter<State> {
    OpenApiRouter::new()
        .routes(routes!(read))
        .routes(routes!(save))
        .with_state(state.clone())
}
