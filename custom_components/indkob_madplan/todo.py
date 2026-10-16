"""Indkøbslisten som almindelig HA-to-do-liste (Assist, automationer, Claude)."""

from __future__ import annotations

from homeassistant.components.todo import (
    TodoItem,
    TodoItemStatus,
    TodoListEntity,
    TodoListEntityFeature,
)
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import IndkobConfigEntry
from .entity import IndkobEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: IndkobConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    async_add_entities([IndkobTodo(entry.runtime_data, "indkobsliste")])


class IndkobTodo(IndkobEntity, TodoListEntity):
    _attr_icon = "mdi:cart-outline"
    _attr_supported_features = (
        TodoListEntityFeature.CREATE_TODO_ITEM
        | TodoListEntityFeature.UPDATE_TODO_ITEM
        | TodoListEntityFeature.DELETE_TODO_ITEM
    )

    @property
    def todo_items(self) -> list[TodoItem]:
        return [
            TodoItem(
                uid=ln["id"],
                summary=ln["text"],
                status=TodoItemStatus.COMPLETED if ln["checked"] else TodoItemStatus.NEEDS_ACTION,
            )
            for ln in self.manager.indkob.items()
        ]

    async def async_create_todo_item(self, item: TodoItem) -> None:
        lines = self.manager.add_items_auto([item.summary or ""], "Home Assistant")
        if lines and item.status == TodoItemStatus.COMPLETED:
            self.manager.update_line(lines[0]["id"], "Home Assistant", checked=True)

    async def async_update_todo_item(self, item: TodoItem) -> None:
        self.manager.update_line(
            item.uid,
            "Home Assistant",
            text=item.summary,
            checked=None if item.status is None else item.status == TodoItemStatus.COMPLETED,
        )

    async def async_delete_todo_items(self, uids: list[str]) -> None:
        self.manager.delete_lines(uids, "Home Assistant")
