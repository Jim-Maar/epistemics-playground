/** The sidebar tree of folders, threads and views, with drag and drop. */
import { useEffect, useMemo, useState, type MouseEvent } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragMoveEvent,
  type Modifier,
} from "@dnd-kit/core";
import { ChevronDown, ChevronRight, Columns2, Copy, Folder, FolderInput, FolderPlus, Link2, MessageSquare, MoreHorizontal, Pencil, SquarePen, Trash2 } from "lucide-react";
import { deleteNode, duplicate, newFolder, newThread, openSideBySide, renamingStore, routeFor } from "../actions";
import { post } from "../api";
import type { NodeRec } from "../db";
import { threadIdsUnder, type Tree } from "../hooks";
import { mergeIntoView, moveNode, update, type DropPlace } from "../repo";
import { navigate, shareUrl, type Route } from "../routing";
import { toast, useStore } from "../stores";
import { InlineEdit, closeDialog, copyText, openDialog, openMenu, type MenuItem } from "./ui";

const EDGE_ZONE = 0.25;
const AUTO_EXPAND_MS = 600;
const DRAG_START_DISTANCE_PX = 6;
const LONG_PRESS_MS = 250;
const LONG_PRESS_TOLERANCE_PX = 8;
const ROOT_END_ID = "root-end";
const INDENT_PX = 16;
const DRAG_CHIP_OFFSET = { x: 14, y: 12 };

function pointerStart(event: Event): { x: number; y: number } {
  const touch = "touches" in event ? (event as TouchEvent).touches[0] : undefined;
  const point = touch ?? (event as globalThis.MouseEvent);
  return { x: point.clientX, y: point.clientY };
}

/** Puts the drag chip right below the pointer instead of on top of the row being targeted. */
const besidePointer: Modifier = ({ activatorEvent, draggingNodeRect, transform }) => {
  if (!activatorEvent || !draggingNodeRect) return transform;
  const start = pointerStart(activatorEvent);
  return {
    ...transform,
    x: transform.x + start.x - draggingNodeRect.left + DRAG_CHIP_OFFSET.x,
    y: transform.y + start.y - draggingNodeRect.top + DRAG_CHIP_OFFSET.y,
  };
};

type Zone = "before" | "after" | "into";
type DropTarget = { id: string; zone: Zone } | null;
type Row = { node: NodeRec; depth: number };

function visibleRows(tree: Tree, parentId: string | null = null, depth = 0): Row[] {
  return (tree.children.get(parentId) ?? []).flatMap((node) => [
    { node, depth },
    ...(node.kind !== "thread" && !node.collapsed ? visibleRows(tree, node.id, depth + 1) : []),
  ]);
}

function isInside(tree: Tree, nodeId: string, ancestorId: string): boolean {
  for (let current = tree.byId.get(nodeId); current?.parentId; current = tree.byId.get(current.parentId)) {
    if (current.parentId === ancestorId) return true;
  }
  return false;
}

/** Decides what a drop at this height of the row would do, or null if it is not allowed. */
function zoneFor(tree: Tree, dragged: NodeRec, over: NodeRec, relativeY: number): Zone | null {
  if (dragged.id === over.id || isInside(tree, over.id, dragged.id)) return null;
  const overParent = over.parentId ? tree.byId.get(over.parentId) : undefined;
  const edge: Zone | null = relativeY < EDGE_ZONE ? "before" : relativeY > 1 - EDGE_ZONE ? "after" : null;
  const half: Zone = relativeY < 0.5 ? "before" : "after";
  if (dragged.kind === "thread") return edge ?? "into";
  if (overParent?.kind === "view") return null;
  if (over.kind === "folder") return edge ?? "into";
  return half;
}

function placeFor(tree: Tree, over: NodeRec, zone: "before" | "after"): DropPlace {
  const firstChild = tree.children.get(over.id)?.[0];
  const openContainer = over.kind !== "thread" && !over.collapsed && firstChild;
  if (zone === "after" && openContainer) return { parentId: over.id, beforeId: firstChild.id };
  return zone === "before" ? { parentId: over.parentId, beforeId: over.id } : { parentId: over.parentId, afterId: over.id };
}

async function applyDrop(tree: Tree, dragged: NodeRec, target: NonNullable<DropTarget>) {
  if (target.id === ROOT_END_ID) return moveNode(dragged.id, { parentId: null });
  const over = tree.byId.get(target.id);
  if (!over) return;
  if (target.zone !== "into") return moveNode(dragged.id, placeFor(tree, over, target.zone));
  if (over.kind === "thread") return openSideBySide(dragged.id, over.id);
  if (over.kind === "view") return void (await mergeIntoView(dragged.id, over.id));
  await moveNode(dragged.id, { parentId: over.id });
  await update<NodeRec>("nodes", over.id, { collapsed: false });
}

// ---------- Pickers used by the menu ----------

function NodePicker(props: { candidates: Row[]; rootLabel?: string; onPick: (nodeId: string | null) => void }) {
  const [query, setQuery] = useState("");
  const matches = props.candidates.filter((row) => row.node.title.toLowerCase().includes(query.toLowerCase()));
  const pick = (id: string | null) => {
    closeDialog();
    props.onPick(id);
  };
  return (
    <div className="picker in-dialog">
      <input id="node-picker-search" className="input" placeholder="Search" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="menu scroll">
        {props.rootLabel && !query && <button className="menu-item" onClick={() => pick(null)}><span>{props.rootLabel}</span></button>}
        {matches.map((row) => (
          <button key={row.node.id} className="menu-item" style={{ paddingLeft: 10 + (query ? 0 : row.depth * INDENT_PX) }} onClick={() => pick(row.node.id)}>
            {row.node.kind === "folder" ? <Folder size={14} /> : <MessageSquare size={14} />}
            <span>{row.node.title}</span>
          </button>
        ))}
        {matches.length === 0 && <p className="muted picker-empty">Nothing matches.</p>}
      </div>
    </div>
  );
}

function allRows(tree: Tree, parentId: string | null = null, depth = 0): Row[] {
  return (tree.children.get(parentId) ?? []).flatMap((node) => [{ node, depth }, ...allRows(tree, node.id, depth + 1)]);
}

function openMoveTo(tree: Tree, node: NodeRec) {
  const folders = allRows(tree).filter((row) => row.node.kind === "folder" && row.node.id !== node.id && !isInside(tree, row.node.id, node.id));
  openDialog(`Move "${node.title}" to`, <NodePicker candidates={folders} rootLabel="Top level" onPick={(id) => void moveNode(node.id, { parentId: id })} />);
}

function openSideBySidePicker(tree: Tree, node: NodeRec) {
  const threads = allRows(tree).filter((row) => row.node.kind === "thread" && row.node.id !== node.id);
  openDialog("Open side by side with", <NodePicker candidates={threads} onPick={(id) => id && void openSideBySide(node.id, id)} />);
}

async function copyShareLink(threadId: string) {
  const { id } = await post<{ id: string }>("/shares", { threadId });
  toast((await copyText(shareUrl(id))) ? "Link copied." : `Link: ${shareUrl(id)}`);
}

function menuFor(tree: Tree, node: NodeRec): MenuItem[] {
  const rename: MenuItem = { label: "Rename", icon: <Pencil size={14} />, shortcut: "F2", onSelect: () => renamingStore.set(node.id) };
  const duplicateItem: MenuItem = { label: "Duplicate", icon: <Copy size={14} />, onSelect: () => void duplicate(node) };
  const moveTo: MenuItem = { label: "Move to…", icon: <FolderInput size={14} />, onSelect: () => openMoveTo(tree, node) };
  const remove: MenuItem = { label: "Delete", icon: <Trash2 size={14} />, danger: true, onSelect: () => void deleteNode(node, tree) };
  if (node.kind === "folder") {
    return [
      { label: "New thread here", icon: <SquarePen size={14} />, onSelect: () => void newThread(node.id) },
      { label: "New folder here", icon: <FolderPlus size={14} />, onSelect: () => void newFolder(node.id) },
      "separator", rename, duplicateItem, moveTo, "separator", remove,
    ];
  }
  if (node.kind === "view") return [rename, duplicateItem, moveTo, "separator", remove];
  return [
    rename, duplicateItem, moveTo,
    { label: "Open side by side with…", icon: <Columns2 size={14} />, onSelect: () => openSideBySidePicker(tree, node) },
    { label: "Copy share link", icon: <Link2 size={14} />, onSelect: () => void copyShareLink(node.id) },
    "separator", remove,
  ];
}

// ---------- Rows ----------

type RowProps = {
  row: Row; tree: Tree; selected: boolean; drop: Zone | null; running: boolean; unseen: boolean; dragging: boolean; onNavigate: () => void;
};

function TreeRow({ row, tree, selected, drop, running, unseen, dragging, onNavigate }: RowProps) {
  const { node, depth } = row;
  const renaming = useStore(renamingStore) === node.id;
  const draggable = useDraggable({ id: node.id, disabled: renaming });
  const droppable = useDroppable({ id: node.id });
  const container = node.kind !== "thread";
  const toggle = () => void update<NodeRec>("nodes", node.id, { collapsed: !node.collapsed });
  const open = () => {
    if (node.kind === "folder") return toggle();
    navigate(routeFor(node));
    onNavigate();
  };
  const menu = (event: MouseEvent, atPointer: boolean) => openMenu(event, menuFor(tree, node), atPointer);
  const classes = ["row", node.kind, selected && "selected", drop && `drop-${drop}`, dragging && "dragging"].filter(Boolean).join(" ");
  return (
    <div
      ref={(element) => {
        draggable.setNodeRef(element);
        droppable.setNodeRef(element);
      }}
      className={classes}
      style={{ paddingLeft: 8 + depth * INDENT_PX }}
      role="treeitem"
      aria-selected={selected}
      aria-expanded={container ? !node.collapsed : undefined}
      tabIndex={0}
      onClick={open}
      onDoubleClick={() => renamingStore.set(node.id)}
      onContextMenu={(event) => menu(event, true)}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter") open();
        if (event.key === "F2") renamingStore.set(node.id);
      }}
      {...draggable.listeners}
    >
      {container ? (
        <button
          className="chevron"
          aria-label={node.collapsed ? "Unfold" : "Fold"}
          onClick={(event) => {
            event.stopPropagation();
            toggle();
          }}
        >
          {node.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
      ) : (
        <span className="chevron-space" />
      )}
      {node.kind === "view" && <Columns2 size={14} className="view-icon" />}
      {renaming ? (
        <InlineEdit
          value={node.title}
          onSave={(title) => {
            renamingStore.set(null);
            void update<NodeRec>("nodes", node.id, { title });
          }}
          onCancel={() => renamingStore.set(null)}
        />
      ) : (
        <span className="row-name">{node.title}</span>
      )}
      {running ? <span className="dot running" title="Running" /> : unseen ? <span className="dot" title="New answer" /> : null}
      {container && !renaming && <span className="row-count">{threadIdsUnder(tree, node.id).length}</span>}
      {!renaming && (
        <button className="row-more" aria-label="Menu" onClick={(event) => menu(event, false)} onPointerDown={(event) => event.stopPropagation()}>
          <MoreHorizontal size={14} />
        </button>
      )}
      {drop === "into" && node.kind === "thread" && <span className="drop-tip">Open side by side</span>}
      {drop === "into" && node.kind === "view" && <span className="drop-tip">Add to this view</span>}
    </div>
  );
}

function RootEnd({ active }: { active: boolean }) {
  const { setNodeRef } = useDroppable({ id: ROOT_END_ID });
  return <div ref={setNodeRef} className={active ? "root-end active" : "root-end"} />;
}

function hasUnseen(tree: Tree, node: NodeRec, selectedId: string | null): boolean {
  return threadIdsUnder(tree, node.id).some((id) => {
    const thread = tree.byId.get(id);
    return id !== selectedId && (thread?.lastActivityAt ?? 0) > (thread?.lastSeenAt ?? 0);
  });
}

export function TreeView(props: { tree: Tree; route: Route; runningThreadIds: Set<string>; onNavigate: () => void }) {
  const { tree, route } = props;
  const rows = useMemo(() => visibleRows(tree), [tree]);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: DRAG_START_DISTANCE_PX } }),
    useSensor(TouchSensor, { activationConstraint: { delay: LONG_PRESS_MS, tolerance: LONG_PRESS_TOLERANCE_PX } }),
  );
  const dragged = draggedId ? tree.byId.get(draggedId) : undefined;
  const selectedId = route.page === "thread" || route.page === "view" ? route.id : null;

  // Holding a dragged item over a folded folder unfolds it.
  useEffect(() => {
    if (target?.zone !== "into") return;
    const over = tree.byId.get(target.id);
    if (over?.kind !== "folder" || !over.collapsed) return;
    const timer = setTimeout(() => void update<NodeRec>("nodes", over.id, { collapsed: false }), AUTO_EXPAND_MS);
    return () => clearTimeout(timer);
  }, [target?.id, target?.zone]);

  const onDragMove = (event: DragMoveEvent) => {
    const over = event.over;
    if (!over || !dragged) return setTarget(null);
    if (over.id === ROOT_END_ID) return setTarget({ id: ROOT_END_ID, zone: "after" });
    const overNode = tree.byId.get(String(over.id));
    const relativeY = (pointerStart(event.activatorEvent).y + event.delta.y - over.rect.top) / over.rect.height;
    const zone = overNode ? zoneFor(tree, dragged, overNode, relativeY) : null;
    setTarget(zone && overNode ? { id: overNode.id, zone } : null);
  };

  const endDrag = (drop: boolean) => {
    if (drop && dragged && target) void applyDrop(tree, dragged, target);
    setDraggedId(null);
    setTarget(null);
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      onDragStart={(event) => setDraggedId(String(event.active.id))}
      onDragMove={onDragMove}
      onDragEnd={() => endDrag(true)}
      onDragCancel={() => endDrag(false)}
    >
      <div className="tree" role="tree">
        {rows.map((row) => (
          <TreeRow
            key={row.node.id}
            row={row}
            tree={tree}
            selected={row.node.id === selectedId}
            drop={target?.id === row.node.id ? target.zone : null}
            running={threadIdsUnder(tree, row.node.id).some((id) => props.runningThreadIds.has(id)) && (row.node.kind === "thread" || Boolean(row.node.collapsed))}
            unseen={(row.node.kind === "thread" || Boolean(row.node.collapsed)) && hasUnseen(tree, row.node, selectedId)}
            dragging={row.node.id === draggedId}
            onNavigate={props.onNavigate}
          />
        ))}
        <RootEnd active={target?.id === ROOT_END_ID} />
      </div>
      <DragOverlay dropAnimation={null} modifiers={[besidePointer]}>
        {dragged && (
          <div className="drag-chip">
            {dragged.kind === "folder" ? <Folder size={14} /> : dragged.kind === "view" ? <Columns2 size={14} /> : <MessageSquare size={14} />}
            {dragged.title}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
