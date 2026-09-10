//! Resolved-scope-expression shape checks for `scope-snapshot-identity.v1`.
//!
//! No scope normalization, algebra, resolution or authority closure occurs here. The
//! expression is validated for kind vocabulary, exact member counts, identifier
//! shapes and depth/atom/selected-source ceilings only.

#![forbid(unsafe_code)]

use super::error::SnapshotIdentityError;
use super::frame::{Value, field};
use super::material::check_identifier_shape_for_expression;
use super::{SNAPSHOT_SCOPE_ATOMS_MAX, SNAPSHOT_SCOPE_DEPTH_MAX, SNAPSHOT_SELECTED_SOURCES_MAX};

struct ExprMetrics {
    depth: usize,
    atoms: usize,
    selected: usize,
}

pub(crate) fn check_expression(value: &Value) -> Result<(), SnapshotIdentityError> {
    let mut metrics = ExprMetrics {
        depth: 0,
        atoms: 0,
        selected: 0,
    };
    walk_expression(value, 1, &mut metrics)?;
    if metrics.depth > SNAPSHOT_SCOPE_DEPTH_MAX
        || metrics.atoms > SNAPSHOT_SCOPE_ATOMS_MAX
        || metrics.selected > SNAPSHOT_SELECTED_SOURCES_MAX
    {
        return Err(SnapshotIdentityError::MemberLimit {
            max_members: SNAPSHOT_SCOPE_ATOMS_MAX,
        });
    }
    Ok(())
}

fn walk_expression(
    value: &Value,
    depth: usize,
    metrics: &mut ExprMetrics,
) -> Result<(), SnapshotIdentityError> {
    if depth > metrics.depth {
        metrics.depth = depth;
    }
    if depth > SNAPSHOT_SCOPE_DEPTH_MAX {
        return Err(SnapshotIdentityError::Expression);
    }
    let members = value.as_object().ok_or(SnapshotIdentityError::Expression)?;
    let kind = field(members, "kind")
        .and_then(Value::as_str)
        .ok_or(SnapshotIdentityError::Expression)?;
    let atom_id = |key: &str| {
        let text = field(members, key)
            .and_then(Value::as_str)
            .ok_or(SnapshotIdentityError::Expression)?;
        check_identifier_shape_for_expression(text)
    };
    match kind {
        "GLOBAL_LIBRARY" => {
            if members.len() != 1 {
                return Err(SnapshotIdentityError::Expression);
            }
        }
        "PROJECT" => {
            if members.len() != 2 {
                return Err(SnapshotIdentityError::Expression);
            }
            atom_id("project_id")?;
        }
        "SELECTED_SOURCES" => {
            if members.len() != 2 {
                return Err(SnapshotIdentityError::Expression);
            }
            let ids = field(members, "source_ids")
                .and_then(Value::as_array)
                .ok_or(SnapshotIdentityError::Expression)?;
            if ids.is_empty() {
                return Err(SnapshotIdentityError::Expression);
            }
            for id in ids {
                check_identifier_shape_for_expression(
                    id.as_str().ok_or(SnapshotIdentityError::Expression)?,
                )?;
            }
            metrics.selected = metrics.selected.saturating_add(ids.len());
        }
        "SOURCE_CLASS" => {
            if members.len() != 2 {
                return Err(SnapshotIdentityError::Expression);
            }
            atom_id("source_class")?;
        }
        "TAG" => {
            if members.len() != 2 {
                return Err(SnapshotIdentityError::Expression);
            }
            atom_id("tag")?;
        }
        "UNION" | "INTERSECT" | "EXCEPT" => {
            if members.len() != 3 {
                return Err(SnapshotIdentityError::Expression);
            }
            walk_expression(
                field(members, "left").ok_or(SnapshotIdentityError::Expression)?,
                depth + 1,
                metrics,
            )?;
            walk_expression(
                field(members, "right").ok_or(SnapshotIdentityError::Expression)?,
                depth + 1,
                metrics,
            )?;
            return Ok(());
        }
        _ => return Err(SnapshotIdentityError::Expression),
    }
    metrics.atoms = metrics.atoms.saturating_add(1);
    Ok(())
}
