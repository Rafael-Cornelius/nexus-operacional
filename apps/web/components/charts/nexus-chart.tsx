"use client";

import dynamic from "next/dynamic";
import type { EChartsOption } from "echarts";
import { Card } from "@/components/ui/card";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

export function NexusChart({ title, option, height = 320 }: { title: string; option: EChartsOption; height?: number }) {
  return (
    <Card className="min-h-[360px]">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="text-xs text-slate-400">interativo</span>
      </div>
      <ReactECharts option={{ backgroundColor: "transparent", textStyle: { color: "#dbeafe" }, animation: false, ...option }} style={{ height }} />
    </Card>
  );
}
