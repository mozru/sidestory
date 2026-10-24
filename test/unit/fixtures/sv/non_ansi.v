// Verilog-2001: non-ANSI ports, always without begin, if / else chains.
module counter (clk, rst, en, load, d, q, wrap);
  input        clk;
  input        rst;
  input        en, load;
  input  [7:0] d;
  output [7:0] q;
  output       wrap;
  reg    [7:0] q;
  wire         wrap = (q == 8'hFF) && en;

  always @(posedge clk)
    if (rst)
      q <= 8'd0;
    else if (load)
      q <= d;
    else if (en)
      q <= q + 8'd1;
    else
      q <= q;
endmodule
