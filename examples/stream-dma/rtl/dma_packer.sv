// dma_packer: realigns bytes from the source's lane offset to the destination's.
//
// A byte in source lane i must land in destination lane (i + shift) mod NB, where
// shift = (dst_off - src_off) mod NB. Each output beat is cut from a two-beat window
// {current input beat, previous input beat}. When dst_off < src_off the first output beat
// needs bytes from the second input beat, so the packer first swallows one beat ("prime").
// When the input runs out, a last output beat may still be due: it's cut from the previous
// beat alone ("flush"). Strobes mask the bytes before the first and after the last.
// On drain (after an error) it empties the FIFO and offers empty-strobe beats, so a write
// burst already on the bus can finish.
module dma_packer #(
  parameter int DW = 64,
  parameter int BW = 18,          // beat-count width
  parameter int NB = DW / 8,      // byte lanes
  parameter int OW = $clog2(NB)   // lane-offset width
) (
  input  logic          clk,
  input  logic          rst_n,
  // control
  input  logic          load,
  input  logic          drain,
  input  logic [OW-1:0] src_off,
  input  logic [OW-1:0] dst_off,
  input  logic [OW-1:0] len_lo,     // length mod NB
  input  logic [BW-1:0] in_beats,   // beats the source touches
  input  logic [BW-1:0] out_beats,  // beats the destination touches
  // from the FIFO
  input  logic          in_valid,
  output logic          in_ready,
  input  logic [DW-1:0] in_data,
  // to the write port
  output logic          out_valid,
  input  logic          out_ready,
  output logic [DW-1:0] out_data,
  output logic [NB-1:0] out_strb
);

  // ---- control state
  logic [OW-1:0] shift_q;
  logic          prime_q;
  logic          first_q;
  logic [BW-1:0] in_left_q, out_left_q;
  logic [NB-1:0] first_strb_q, last_strb_q;
  logic          flush, take, emit;

  // ---- datapath state
  logic [DW-1:0]   prev_q;
  logic [2*DW-1:0] window;
  logic [OW+3:0]   rot_bits;

  assign flush = in_left_q == '0;

  // Handshakes: priming takes a beat without emitting one; afterwards each output beat
  // consumes one input beat, except a flush, which consumes none.
  assign in_ready  = drain || (!flush && (prime_q || (out_ready && out_left_q != '0)));
  assign out_valid = drain || (!prime_q && (out_left_q != '0) && (in_valid || flush));
  assign take      = in_valid && in_ready;
  assign emit      = out_valid && out_ready;

  // Byte rotation: output lane j takes window byte j + NB - shift.
  assign window   = {flush ? {DW{1'b0}} : in_data, prev_q};
  assign rot_bits = (OW+4)'((NB - int'(shift_q)) * 8);
  assign out_data = DW'(window >> rot_bits);

  // Strobes: the first beat starts at dst_off, the last ends at (dst_off + len - 1) mod NB.
  always_comb begin
    out_strb = '1;
    if (first_q)                out_strb &= first_strb_q;
    if (out_left_q == BW'(1))   out_strb &= last_strb_q;
    if (drain)                  out_strb  = '0;
  end

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      shift_q      <= '0;
      prime_q      <= 1'b0;
      first_q      <= 1'b0;
      in_left_q    <= '0;
      out_left_q   <= '0;
      first_strb_q <= '0;
      last_strb_q  <= '0;
    end else if (load) begin
      shift_q      <= dst_off - src_off;
      prime_q      <= dst_off < src_off;
      first_q      <= 1'b1;
      in_left_q    <= in_beats;
      out_left_q   <= out_beats;
      first_strb_q <= {NB{1'b1}} << dst_off;
      last_strb_q  <= {NB{1'b1}} >> (OW'(NB - 1) - (dst_off + len_lo - 1'b1));
    end else if (!drain) begin
      if (take) begin
        in_left_q <= in_left_q - 1'b1;
        prime_q   <= 1'b0;
      end
      if (emit) begin
        out_left_q <= out_left_q - 1'b1;
        first_q    <= 1'b0;
      end
    end
  end

  always_ff @(posedge clk) begin
    if (take) prev_q <= in_data;
  end

endmodule
