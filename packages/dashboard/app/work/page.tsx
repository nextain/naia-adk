// 작업 탭: 작업보드를 대시보드 안에 그대로 보여 준다. 위쪽 탭은 대시보드 것 하나만 쓴다.
export default function WorkPage() {
  return (
    <iframe
      src="/board/index.html"
      title="작업보드"
      className="fixed inset-x-0 top-14 h-[calc(100dvh-3.5rem)] w-full border-0 bg-neutral-950"
    />
  )
}
