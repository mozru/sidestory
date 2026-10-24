// case items: several labels, default, unique0 / priority, a one-hot case (1'b1) FSM with expression labels.
module fsm_cases (
  input  logic       clk,
  input  logic       rst_ni,
  input  logic [1:0] sel,
  input  logic       go
);
  typedef enum logic [2:0] { IDLE, RUN, WAIT, DONE } state_e;
  localparam int IDLE_BIT = 0, RUN_BIT = 1;
  state_e     state_q, state_d;
  logic [3:0] onehot_q, onehot_d;
  logic [1:0] mux;

  always_comb begin
    state_d = state_q;
    unique0 case (state_q)
      IDLE, WAIT: if (go) state_d = RUN;
      RUN: begin
        case (sel)
          2'b01:   state_d = DONE;
          default: state_d = RUN;
        endcase
      end
      default: state_d = IDLE;
    endcase
  end

  always_comb begin
    onehot_d = onehot_q;
    priority case (1'b1)
      onehot_q[IDLE_BIT]: onehot_d = 4'b0010;
      onehot_q[RUN_BIT]:  onehot_d = 4'b0001;
    endcase
  end

  always_comb begin
    case (sel) inside
      [2'd0:2'd1]: mux = 2'd0;
      {1'b1, 1'b0}: mux = 2'd2;
      default:     mux = 2'd3;
    endcase
  end

  always_ff @(posedge clk or negedge rst_ni) begin
    if (!rst_ni) begin
      state_q  <= IDLE;
      onehot_q <= 4'b0001;
    end else begin
      state_q  <= state_d;
      onehot_q <= onehot_d;
    end
  end
endmodule
