// A half-typed edit: an always block that never ends.
module unbalanced (
  input  logic clk,
  input  logic d,
  output logic q
);
  logic held;

  always_ff @(posedge clk) begin
    if (d) begin
      q <= d;
    // the `end`s are missing

  assign held = q;
endmodule

module after_it (input logic a, output logic b);
  assign b = a;
endmodule
