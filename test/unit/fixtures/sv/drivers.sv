// What counts as driving a signal (docs/AUTHORING-PLAN.md §4.2).
module drivers (
  input  logic       clk,
  input  logic       arst_n,
  input  logic       srst,
  input  logic [7:0] a, b,
  input  logic [3:0] cnt_max,
  output logic [7:0] sum,
  output logic       carry
);
  logic [7:0] cnt_q, acc_q, word;
  logic       hit_q, first_q;
  logic [3:0] idx;

  // `<=` inside a condition is a comparison
  always_ff @(posedge clk) begin
    if (cnt_q <= cnt_max) hit_q <= 1'b1;
  end

  assign {carry, sum} = a + b;

  // slices driven separately
  assign word[7:4] = a[3:0];
  assign word[3:0] = b[3:0];

  // reset and functional branches, compound assignments, ++, for loops, intra-assignment delays
  always_ff @(posedge clk or negedge arst_n) begin
    if (!arst_n) begin
      cnt_q   <= '0;
      first_q <= 1'b1;
    end else if (srst) begin
      cnt_q <= '0;
    end else begin
      acc_q   <= #1 acc_q + 8'd1;
      first_q <= 1'b0;
      cnt_q++;
    end
  end

  always_comb begin
    idx = '0;
    for (int i = 0; i < 4; i++) idx += 4'(a[i]);
  end
endmodule
