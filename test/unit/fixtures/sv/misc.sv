// Labelled blocks and assertions, functions and tasks, extern prototypes, macros, a class, connections.
`define FF(q, d, rst) always_ff @(posedge clk_i) q <= d;
module misc #(parameter int W = 8) (
  input  logic         clk_i,
  input  logic         rst_ni,
  input  logic [W-1:0] din,
  output logic [W-1:0] dout,
  output logic         full
);
  logic [W-1:0] stage_q, stage_d;
  logic         count_q;

  `FF(stage_q, stage_d, '0)

  always_ff @(posedge clk_i) begin : seq
    dout <= stage_q;
  end

  pipe_reg: always_comb stage_d = din;

  function automatic logic [W-1:0] next_len(input logic [W-1:0] x);
    return x + 1;
  endfunction

  task automatic pulse();
    @(posedge clk_i);
  endtask

  a_no_ovf: assert property (@(posedge clk_i) disable iff (!rst_ni) !(full && din[0]))
    else $error("overflow");

  sync_fifo #(.DEPTH(4)) u_fifo (
    .clk(clk_i),
    .rst_n (rst_ni),
    .wdata(stage_q
           ),
    .full,
    .*
  );

  sync_fifo u_pos (clk_i, rst_ni);

  assign count_q = full;
endmodule

class packet;
  rand bit [7:0] len;
  extern function void show();
  pure virtual task send();
  constraint c_len { len inside {[1:16]}; }
endclass

function void packet::show();
  $display("%0d", len);
endfunction
