import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
} from "lightweight-charts";
import type { UTCTimestamp } from "lightweight-charts";
import type { ChartSpec } from "@nomo/shared";

const OVERLAY_COLORS = ["#4f7cff", "#f2a93b", "#b085f5", "#2fbf9f"];

interface Props {
  spec: ChartSpec;
}

export default function ChartBlock({ spec }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      height: 320,
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#9aa3b2",
      },
      grid: {
        vertLines: { color: "#1f242e" },
        horzLines: { color: "#1f242e" },
      },
      timeScale: {
        timeVisible: spec.intraday,
        secondsVisible: false,
        borderColor: "#262b36",
      },
      rightPriceScale: { borderColor: "#262b36" },
    });

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: "#26a69a",
      downColor: "#ef5350",
      wickUpColor: "#26a69a",
      wickDownColor: "#ef5350",
      borderVisible: false,
    });
    candles.setData(
      spec.bars.map((bar) => ({
        time: bar.time as UTCTimestamp,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
      })),
    );

    if (spec.showVolume) {
      const volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "volume",
        lastValueVisible: false,
        priceLineVisible: false,
      });
      // Squeeze the volume pane into the bottom fifth of the chart.
      chart.priceScale("volume").applyOptions({
        scaleMargins: { top: 0.8, bottom: 0 },
      });
      volume.setData(
        spec.bars.map((bar) => ({
          time: bar.time as UTCTimestamp,
          value: bar.volume,
          color: bar.close >= bar.open ? "rgba(38, 166, 154, 0.5)" : "rgba(239, 83, 80, 0.5)",
        })),
      );
    }

    spec.overlays.forEach((overlay, index) => {
      const line = chart.addSeries(LineSeries, {
        color: OVERLAY_COLORS[index % OVERLAY_COLORS.length],
        lineWidth: 2,
        lastValueVisible: false,
        priceLineVisible: false,
      });
      line.setData(
        overlay.series
          .filter((point): point is { time: number; value: number } => point.value !== null)
          .map((point) => ({ time: point.time as UTCTimestamp, value: point.value })),
      );
    });

    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [spec]);

  return (
    <div className="chart-block">
      <div className="chart-caption">
        <span className="chart-caption-ticker">{spec.ticker}</span>
        <span className="muted">{spec.timeframe}</span>
        {spec.overlays.map((overlay, index) => (
          <span
            key={`${overlay.label}-${index}`}
            className="chart-caption-overlay"
            style={{ color: OVERLAY_COLORS[index % OVERLAY_COLORS.length] }}
          >
            {overlay.label}
          </span>
        ))}
      </div>
      <div ref={containerRef} className="chart-canvas" />
    </div>
  );
}
