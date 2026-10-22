module bit_reader #(
  parameter int W = 64
) (
  input  logic         clk,
  input  logic         rst_n,
  // bytes arrive last-first (backward stream)
  input  logic [7:0]   in_byte,
  input  logic         in_valid,
  output logic         in_ready,
  // consumer side
  input  logic [5:0]   rd_bits,
  input  logic         rd_en,
  output logic [W-1:0] peek,
  output logic         avail
);
  logic [W-1:0] buf_q;   // MSB-aligned bit window
  logic [6:0]   cnt_q;   // valid bits in buf_q

  assign in_ready = (cnt_q <= 7'(W - 8));
  assign avail    = (cnt_q >= 7'(rd_bits));
  assign peek     = buf_q;

  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      buf_q <= '0;
      cnt_q <= '0;
    end else begin
      logic [W-1:0] b;
      logic [6:0]   c;
      b = buf_q;  c = cnt_q;
      if (rd_en && avail) begin        // consume from the top
        b = b << rd_bits;
        c = c - 7'(rd_bits);
      end
      if (in_valid && in_ready) begin  // refill below valid bits
        b = b | (W'(in_byte) << (W - 8 - c));
        c = c + 7'd8;
      end
      buf_q <= b;
      cnt_q <= c;
    end
  end
endmodule
