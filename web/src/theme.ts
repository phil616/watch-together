import {
  createTheme,
  Button,
  Paper,
  TextInput,
  NativeSelect,
} from "@mantine/core";

/** Shared design tokens; component states and accessibility stay with Mantine. */
export const theme = createTheme({
  primaryColor: "amber",
  primaryShade: 5,
  autoContrast: true,
  colors: {
    amber: [
      "#fff8e8",
      "#ffedc2",
      "#ffdf91",
      "#ffd060",
      "#f8c044",
      "#e8ad35",
      "#ca8d21",
      "#a66e16",
      "#875612",
      "#70460f",
    ],
    dark: [
      "#e2e6ee",
      "#a7afbd",
      "#8993a4",
      "#596374",
      "#333d4c",
      "#252d3a",
      "#1b2230",
      "#141b26",
      "#101620",
      "#0b1018",
    ],
  },
  fontFamily:
    '"Noto Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  headings: { fontFamily: "inherit", fontWeight: "700" },
  defaultRadius: "md",
  focusRing: "auto",
  components: {
    Button: Button.extend({ defaultProps: { size: "sm" } }),
    Paper: Paper.extend({
      defaultProps: { withBorder: true, radius: "lg", p: "xl" },
    }),
    TextInput: TextInput.extend({ defaultProps: { size: "md" } }),
    NativeSelect: NativeSelect.extend({ defaultProps: { size: "md" } }),
  },
});
