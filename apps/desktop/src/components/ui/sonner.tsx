import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      theme="light"
      position="top-center"
      offset={16}
      duration={1800}
      className="toaster group"
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "mx-auto flex w-fit items-center gap-2 rounded-full border-0 bg-ink px-3.5 py-2 text-[13px] leading-5 text-white shadow-lg",
          title: "font-normal",
          icon: "m-0 flex size-4 items-center justify-center",
        },
      }}
      icons={{
        success: (
          <CheckIcon className="size-3.5" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--width": "max-content",
        } as React.CSSProperties
      }
      {...props}
    />
  )
}

export { Toaster }
