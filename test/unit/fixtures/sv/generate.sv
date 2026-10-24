// A generate-heavy packer: for, if and case generate, nested labels, an unlabelled block.
module gen_packer #(
  parameter int LANES = 4,
  parameter bit REGISTERED = 1'b1,
  parameter int MODE = 0
) (
  input  logic             clk,
  input  logic [LANES-1:0] lane_in,
  output logic [LANES-1:0] lane_out
);
  genvar i;

  for (i = 0; i < LANES; i++) begin : g_lane
    logic lane_q;
    // one flop per lane
    always_ff @(posedge clk) lane_q <= lane_in[i];
    if (REGISTERED) begin : g_reg
      logic out_q;
      always_ff @(posedge clk) out_q <= lane_q;
      assign lane_out[i] = out_q;
    end else begin : g_comb
      assign lane_out[i] = lane_q;
    end
  end

  case (MODE)
    0: begin : g_mode0
      logic mode_q;
      assign mode_q = 1'b0;
    end
    default: begin : g_mode_other
      logic mode_q;
      assign mode_q = 1'b1;
    end
  endcase

  generate
    if (LANES > 2) begin
      logic wide;
      assign wide = 1'b1;
    end
  endgenerate

  g_named: for (genvar j = 0; j < 2; j++) begin
    logic pair_q;
    assign pair_q = lane_in[j];
  end
endmodule
