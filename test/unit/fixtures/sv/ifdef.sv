// `ifdef arms that open a scope differently (the async-reset pattern): only the first arm is scanned.
module ifdef_flop (
  input  logic clk,
  input  logic rst_n,
  input  logic d,
  output logic q
);
`ifdef ASYNC_RST
  always_ff @(posedge clk or negedge rst_n) begin
`else
  always_ff @(posedge clk) begin
`endif
    if (!rst_n) q <= 1'b0;
    else        q <= d;
  end

`ifdef DEBUG
  logic dbg_seen;
  assign dbg_seen = q;
`elsif TRACE
  logic trace_only;
  assign trace_only = d;
`else
  logic dbg_seen;
  assign dbg_seen = 1'b0;
`endif

`ifndef SYNTHESIS
  initial $display("sim");
`endif
endmodule
