// dma_addr_gen: cuts a transfer into bursts. Each burst is at most MAX_BURST beats and never
// crosses a 4 KB boundary (the bus forbids it), so a burst's length is the smallest of three
// limits: MAX_BURST, the beats left, and the beats to the next 4 KB boundary.
//
// One instance walks the source (reads), another the destination (writes).
module dma_addr_gen #(
  parameter int AW        = 32,
  parameter int LW        = 20,             // transfer length width (bytes)
  parameter int MAX_BURST = 16,             // beats
  parameter int BW        = LW - 2,         // beat-count width
  parameter int BLW       = $clog2(MAX_BURST) + 1
) (
  input  logic           clk,
  input  logic           rst_n,
  // control
  input  logic           load,         // latch base and length (dma_ctrl, LOAD)
  input  logic [AW-1:0]  base,         // byte address, any alignment
  input  logic [LW-1:0]  len,          // bytes
  input  logic           burst_ack,    // the port took the current burst
  output logic           has_burst,    // bursts remain
  // the current burst
  output logic [AW-1:0]  burst_addr,   // beat aligned
  output logic [BLW-1:0] burst_len,    // beats, 1..MAX_BURST
  output logic [BW-1:0]  total_beats   // beats the whole transfer touches
);

  // ---- datapath registers: where the next burst starts, how many beats remain
  logic [AW-1:0] addr_q;
  logic [BW-1:0] left_q;

  // Beats the transfer touches: the offset into the first beat plus the length, rounded up.
  logic [LW:0] span;
  assign span        = {1'b0, len} + (LW+1)'(base[2:0]) + (LW+1)'(7);
  assign total_beats = BW'(span >> 3);

  // Beats from addr_q to the next 4 KB boundary: (4096 - addr[11:0]) / 8, 1..512.
  logic [9:0] to_4k;
  assign to_4k = 10'd512 - {1'b0, addr_q[11:3]};

  // ---- the three limits
  logic hit_4k, tail;
  assign hit_4k = to_4k < 10'(MAX_BURST);      // a 4 KB boundary comes first
  assign tail   = left_q < BW'(MAX_BURST);     // fewer than MAX_BURST beats left

  always_comb begin
    burst_len = BLW'(MAX_BURST);
    if (hit_4k && (to_4k[BLW-1:0] < burst_len)) burst_len = to_4k[BLW-1:0];
    if (tail && (left_q[BLW-1:0] < burst_len))  burst_len = left_q[BLW-1:0];
  end

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      addr_q <= '0;
      left_q <= '0;
    end else if (load) begin
      addr_q <= {base[AW-1:3], 3'b000};
      left_q <= total_beats;
    end else if (burst_ack && has_burst) begin
      addr_q <= addr_q + AW'({burst_len, 3'b000});
      left_q <= left_q - BW'(burst_len);
    end
  end

  assign has_burst  = left_q != '0;
  assign burst_addr = addr_q;

endmodule
