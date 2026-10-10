import { createCn } from "cn/config";

/** clsx + tailwind-merge, taught the app's own scales so `text-display` merges as a size, not a colour. */
export const cn = createCn({
  extend: {
    theme: {
      text: ["caption", "small", "body", "lead", "heading", "title", "display"],
      radius: ["menu"],
      shadow: ["sheet", "lift", "float"],
    },
  },
});
