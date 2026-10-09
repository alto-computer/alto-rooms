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
          // Sonner positions a toast absolutely inside its 356px toaster band; with both insets set,
          // mx-auto centres the pill there and w-fit keeps it to its text.
          toast:
            "inset-x-0 mx-auto flex w-fit items-center gap-2 rounded-full border-0 bg-ink px-3.5 py-2 text-body text-pane shadow-float",
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
      {...props}
    />
  )
}

export { Toaster }
