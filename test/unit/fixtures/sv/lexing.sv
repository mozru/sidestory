/* Comments and strings that look like code: begin end module endmodule "//" */
module lexing (
  input  logic \bus[0] ,
  (* mark_debug = "true" *) input logic clk,
  output logic out_q
);
  // module fake; begin end endmodule
  string s = "begin // not a comment end";
  string t = "a \" quote with endmodule";
  (* keep *) logic keep_me;
  logic [7:0] lit = 8'hFF;
  logic [7:0] lit2 = 8 'b1010_x0z1;
  logic [3:0] fill = '0;
  `define TWO_LINES(a) \
    a + \
    a
  `timescale 1ns/1ps
  always @(*) keep_me = \bus[0] ;
  always_ff @(posedge clk) begin
    out_q <= `TWO_LINES(keep_me); // `define bodies and uses are opaque
  end
  assign fill = {4{lit[0]}};
endmodule
