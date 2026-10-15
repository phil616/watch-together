import { Text } from "@mantine/core";
import { modals } from "@mantine/modals";

/** Accessible, focus-trapped confirmation shared by destructive room actions. */
export function confirmAction(
  title: string,
  message: string,
): Promise<boolean> {
  return new Promise((resolve) => {
    modals.openConfirmModal({
      title,
      centered: true,
      children: (
        <Text size="sm" c="dimmed">
          {message}
        </Text>
      ),
      labels: { confirm: "确认操作", cancel: "取消" },
      confirmProps: { color: "red" },
      onConfirm: () => resolve(true),
      onCancel: () => resolve(false),
      onClose: () => resolve(false),
    });
  });
}
